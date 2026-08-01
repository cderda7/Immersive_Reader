"""Stateless FastAPI backend.

Per the locked architecture: no database, no auth, no accounts. Two
stateless endpoints today: syllabification (fast enough to run live,
on-the-spot, against a passage handed to you at demo time) and
tap-to-define (backed by word_info.py). This file is intentionally the
whole backend, not a package, while the surface area is this small.
"""

from dotenv import load_dotenv

# Must run before word_info is imported below -- word_info's Anthropic
# client is constructed lazily, but load_dotenv() still has to have
# populated ANTHROPIC_API_KEY into the environment by the time anything
# actually calls it. A no-op if backend/.env doesn't exist.
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from syllabify import syllabify
from word_info import get_word_example, get_word_info_quick, simplify_sentence

app = FastAPI(title="Immersive Reader API")

# TEMPORARY, per Carson (Aug 1 2026): the previous version of this
# (allow_origins=[specific domains] + allow_origin_regex for Vercel
# preview subdomains) was producing a live "Disallowed CORS origin" 400
# on the browser's OPTIONS preflight against the real, confirmed-correct
# production origin -- root cause not yet nailed down (possibly a stale
# Railway deployment lagging behind an origin-matching edit, possibly
# something more subtle in the exact string match), and debugging it live
# was costing more than it was worth. This app has no auth, no cookies,
# no per-user data (see this file's module docstring -- stateless, no
# accounts) -- there's nothing a wildcard origin actually exposes here,
# so allow_origins=["*"] removes origin-matching as a variable entirely
# instead of continuing to guess at it. allow_credentials is deliberately
# left at its default (False) -- that's what makes "*" valid at all here;
# don't add cookie/session auth later without revisiting this.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


class SyllabifyRequest(BaseModel):
    passage: str


class WordInfoRequest(BaseModel):
    word: str
    sentence: str


class SimplifySentenceRequest(BaseModel):
    sentence: str
    grade_level: int


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/syllabify")
def syllabify_route(req: SyllabifyRequest):
    return {"syllables": syllabify(req.passage)}


@app.post("/api/word-info")
def word_info_route(req: WordInfoRequest):
    # Caught explicitly, not left to FastAPI's default exception handler:
    # an unhandled exception here would bubble out through Starlette's
    # ServerErrorMiddleware, which sits OUTSIDE CORSMiddleware -- the
    # resulting 500 has no CORS headers at all, and the browser reports
    # that as an opaque "Failed to fetch" instead of the real error. See
    # TROUBLESHOOTING.md.
    #
    # Fast path only (dictionary + rules, no Claude) -- see
    # word_info.py's module docstring for why this is split from
    # /api/word-example below.
    try:
        return get_word_info_quick(req.word, req.sentence)
    except Exception as exc:
        return JSONResponse(status_code=502, content={"error": str(exc)})


@app.post("/api/word-example")
def word_example_route(req: WordInfoRequest):
    # The frontend fires this at the same moment as /api/word-info, not
    # after it -- see useTapWord.ts's fetchWordInfo. Same CORS-safe
    # exception handling as above.
    try:
        return get_word_example(req.word, req.sentence)
    except Exception as exc:
        return JSONResponse(status_code=502, content={"error": str(exc)})


@app.post("/api/simplify-sentence")
def simplify_sentence_route(req: SimplifySentenceRequest):
    # Same CORS-safe exception handling as the tap-word routes above --
    # see word_info.py's simplify_sentence for the teacher-configured
    # grade_level this rewrites toward.
    try:
        return simplify_sentence(req.sentence, req.grade_level)
    except Exception as exc:
        return JSONResponse(status_code=502, content={"error": str(exc)})
