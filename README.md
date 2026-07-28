# Immersive Reader

For students grade 7-12 with reading fluency problems. Via multisensory learning,
IMMERSIVE_READER helps students develop flow in reading.

Highlight: syllable - word - paragraph,
with syllable being the darkest shade of blue & paragraph being the lightest.

Student hits space bar (or clicks a word) to progress from one syllable to
the next, matching their reading rhythm.

Bottom controls:
text size | text spacing <--> | text spacing ^ | return to

## Status (Day 1: core reading experience)

Scope lock + UX sketch done. App scaffold, syllabification pipeline, and
the reading UI (paragraph/word/syllable highlighting, manual pacing,
return-to) are stood up below and build cleanly. Not yet wired: real
passage input/content-authoring flow, checkpoints, and the LLM-backed
features (Day 2).

## Stack

- **Frontend** (`frontend/`) — Next.js 16 / TypeScript / Tailwind v4.
  Owns rendering, keyboard/click handling, the three highlight tiers,
  typography controls, "return to" jump + timeout, and scroll-into-view.
- **Backend** (`backend/`) — stateless FastAPI service. No database, no
  auth, no accounts. Today its only job is syllabification via
  **Pyphen** (`en_US`), fast enough to run live against a passage handed
  to you on the spot. LLM-backed routes (summary assessment,
  tap-to-define) get added here later as additional stateless endpoints.

Core demo passages ship as static data bundled with the frontend
(`frontend/lib/sampleData.ts`) so the reading experience itself never
depends on a live API call. The "Test live syllabification" panel on the
reading screen calls the FastAPI backend directly, as the scalability
proof point for arbitrary text.

## Data model

Syllables are a **flat list**, each tagged with
`(paragraph_idx, word_idx, syllable_idx)`. Advancing on spacebar is just
`currentIndex + 1` into that list — the three highlight tiers are derived
by comparing indices, no tree-walking needed. See
`backend/syllabify.py` and `frontend/lib/types.ts`.

## Running locally

Backend:

```
cd backend
python3 -m venv .venv && source .venv/bin/activate   # if not already set up
pip install -r requirements.txt
uvicorn main:app --reload   # http://localhost:8000
```

Frontend:

```
cd frontend
npm install
cp .env.local.example .env.local
npm run dev   # http://localhost:3000
```
