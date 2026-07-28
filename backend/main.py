"""Stateless FastAPI backend.

Per the locked architecture: no database, no auth, no accounts. The only
job of this service today is syllabification (fast enough to run live,
on-the-spot, against a passage handed to you at demo time). LLM-backed
routes (summary assessment, tap-to-define) get added here later as
additional stateless endpoints -- this file is intentionally the whole
backend, not a package, while the surface area is this small.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from syllabify import syllabify

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


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/syllabify")
def syllabify_route(req: SyllabifyRequest):
    return {"syllables": syllabify(req.passage)}
