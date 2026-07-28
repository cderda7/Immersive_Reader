# Immersive Reader

**Next Goal**

- load passage, syllabify (generating the singly linked list passage_as_syllables), print it
- space advances nested highlight
- no problems yet

For students grade 7-12 with reading fluency problems. Via multisensory learning,
IMMERSIVE_READER helps students develop flow in reading.

Highlight: syllable - word - paragraph,
with syllable being the darkest shade of blue & paragraph being the lightest.

Student hits space bar to progress from one syllable to the next,
matching their reading rhythm.

Bottom controls:
text size | text spacing <--> | text spacing ^ | return to

**Frontend** (`frontend/`) - browser UI:

- Rendering the passage
- Keyboard (space, clicks)
- Highlighting (three nested levels)
- Typography controls (size, spacing)
- “Return to” jump + timeout
- Scrolling so the current syllable stays visible

**Backend** (`backend/`):

- Ingest / normalize the passage text
- Syllabify → structured data (syllable list with paragraph/word indices) via **Pyphen** (`en_US`)
- Problem generation from the passage
