"""Stateless FastAPI backend.

Per the locked architecture: no database, no auth, no accounts. Two jobs
today: syllabification (fast enough to run live, on-the-spot, against a
passage handed to you at demo time) and tap-to-define word lookups (the
first LLM-backed route -- see word_info.py). Both are stateless
endpoints -- this file is intentionally the whole backend, not a
package, while the surface area is this small.
"""

from dotenv import load_dotenv

# Must run before importing word_info, so ANTHROPIC_API_KEY is already in
# the environment by the time its Anthropic client gets constructed.
# No-op (doesn't raise) if backend/.env doesn't exist yet -- see
# .env.example for what to copy it from.
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from syllabify import syllabify
from word_info import get_word_info

app = FastAPI(title="Immersive Reader API")

# Local dev only -- tighten before shipping if this ends up deployed
# somewhere other than alongside the frontend.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


class SyllabifyRequest(BaseModel):
    passage: str


class WordInfoRequest(BaseModel):
    word: str
    sentence: str


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/syllabify")
def syllabify_route(req: SyllabifyRequest):
    return {"syllables": syllabify(req.passage)}


@app.post("/api/word-info")
def word_info_route(req: WordInfoRequest):
    try:
        return get_word_info(req.word, req.sentence)
    except Exception as exc:
        # Deliberately caught here rather than left to propagate: an
        # unhandled exception gets turned into a 500 by Starlette's
        # ServerErrorMiddleware, which sits OUTSIDE the CORSMiddleware
        # layer added above -- so that response comes back with no
        # Access-Control-Allow-Origin header, the browser blocks it, and
        # fetch() on the frontend sees an opaque "Failed to fetch"
        # instead of the real error (most commonly Anthropic being
        # unreachable -- APIConnectionError -- or ANTHROPIC_API_KEY being
        # missing/invalid). Returning a normal response here instead
        # keeps it inside CORSMiddleware's path, so the frontend gets a
        # real status code and message to show.
        return JSONResponse(status_code=502, content={"error": str(exc)})
