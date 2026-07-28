"""Syllabification pipeline.

Splits a passage into paragraphs -> words -> syllables using Pyphen
(written syllable breaks, e.g. "im-mer-sive", not phonetic breaks).

Output is a FLAT list of syllable dicts, each tagged with
(paragraph_idx, sentence_idx, word_idx, syllable_idx) index tuples. This
is the shape the frontend consumes: advancing on spacebar is just
`index + 1` into this flat list, and each highlight tier (paragraph/
sentence/word/syllable) is derived by comparing indices, with no
tree-walking required. sentence_idx is paragraph-relative (resets to 0
each paragraph), same convention as word_idx.

SENTENCE SPLITTING is a plain punctuation heuristic (see
_SENTENCE_SPLIT_RE below), not real sentence-boundary detection --
abbreviations like "Dr. Smith" or "e.g. this" will incorrectly split into
two "sentences". Same trade-off as the syllable overrides below: fine for
hand-picked, spot-checked demo passages; a real risk against arbitrary
teacher-pasted text.

KNOWN LIMITATION: Pyphen's en_US dictionary is built from TeX/LibreOffice
line-breaking patterns, not pronunciation data -- it finds typographically
legal hyphenation points, not necessarily the syllable break a reader
would say aloud. Tested empirically (see backend/audit_syllables.py):
tuning Pyphen's left/right margins does NOT reliably fix this, and can
make it worse (e.g. loosening margins turns "silent" into "silen-t" --
a stray single-letter "syllable" that's wrong either way). SYLLABLE_OVERRIDES
below is a hand-checked correction table, consulted before Pyphen runs, for
words Pyphen's pattern data has no entry for at all.

The current table isn't hand-guessed word-by-word -- it's the result of a
systematic sweep: the ~1200 most frequent English words (via the `wordfreq`
package) cross-checked against real pronunciation data (CMUdict, via
`pronouncing`) for actual syllable counts, filtered to words Pyphen still
returns as a single unbroken piece. That surfaced 49 more misses beyond the
original 7 found by hand, each syllable break verified individually before
being added here.

Deliberately EXCLUDED, not missed: "fire", "hour", "hours", "gonna". These
came back as genuine syllable-count mismatches too, but their "correct"
syllable count is dialect/register-dependent (fire/hour: one syllable in
fast speech, two in careful/sung speech; gonna: informal contraction, not
real orthography) -- forcing a break would be asserting a wrong answer with
false confidence, worse than leaving them alone. If your demo passages lean
on any of these, make the call by ear rather than trusting an override.

To extend this further: rerun the sweep in this docstring's history against
a larger word list (wordfreq's top_n_list accepts any N), or grow it word-by-
word from audit_syllables.py findings against your actual passages -- either
way, verify each break before adding it, the same "AI proposes, human
approves" pattern used for question generation elsewhere in this project.
"""

import re
from dataclasses import dataclass, asdict

import pyphen

dic = pyphen.Pyphen(lang="en_US")

# Words Pyphen's en_US dictionary refuses to break (or breaks incorrectly)
# at any margin setting, hand-verified against a dictionary syllabification.
# Keys are lowercase; casing of the original token is reapplied by the caller.
SYLLABLE_OVERRIDES: dict[str, list[str]] = {
    "able": ["a", "ble"],
    "about": ["a", "bout"],
    "above": ["a", "bove"],
    "across": ["a", "cross"],
    "added": ["add", "ed"],
    "again": ["a", "gain"],
    "against": ["a", "gainst"],
    "agree": ["a", "gree"],
    "ahead": ["a", "head"],
    "alone": ["a", "lone"],
    "along": ["a", "long"],
    "among": ["a", "mong"],
    "amount": ["a", "mount"],
    "april": ["a", "pril"],
    "area": ["ar", "e", "a"],
    "army": ["ar", "my"],
    "around": ["a", "round"],
    "away": ["a", "way"],
    "body": ["bod", "y"],
    "british": ["brit", "ish"],
    "changes": ["chang", "es"],
    "city": ["cit", "y"],
    "crazy": ["cra", "zy"],
    "david": ["da", "vid"],
    "easy": ["eas", "y"],
    "enough": ["e", "nough"],
    "episode": ["ep", "i", "sode"],
    "even": ["e", "ven"],
    "event": ["e", "vent"],
    "events": ["e", "vents"],
    "forces": ["forc", "es"],
    "heavy": ["heav", "y"],
    "idea": ["i", "de", "a"],
    "lazy": ["la", "zy"],
    "longer": ["long", "er"],
    "many": ["man", "y"],
    "maybe": ["may", "be"],
    "michael": ["mi", "chael"],
    "minute": ["min", "ute"],
    "movie": ["mov", "ie"],
    "okay": ["o", "kay"],
    "open": ["o", "pen"],
    "over": ["o", "ver"],
    "places": ["plac", "es"],
    "present": ["pres", "ent"],
    "process": ["proc", "ess"],
    "project": ["proj", "ect"],
    "ready": ["read", "y"],
    "rather": ["rath", "er"],
    "record": ["rec", "ord"],
    "silent": ["si", "lent"],
    "study": ["stud", "y"],
    "tonight": ["to", "night"],
    "union": ["un", "ion"],
    "very": ["ver", "y"],
    "video": ["vid", "e", "o"],
    "whether": ["wheth", "er"],
}

# Split a token into (leading punctuation, core word, trailing punctuation),
# e.g. "(dog." -> ("(", "dog", "."), so punctuation rides along with the
# syllable it's attached to instead of getting syllabified itself.
_WORD_RE = re.compile(r"^(\W*)([\w'-]*)(\W*)$", re.UNICODE)

# Sentence boundary: ./!/? followed by whitespace. See docstring above for
# the abbreviation caveat.
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


@dataclass
class Syllable:
    text: str
    paragraph_idx: int
    sentence_idx: int
    word_idx: int
    syllable_idx: int
    is_first_in_word: bool
    is_last_in_word: bool


def _split_sentences(paragraph: str) -> list[str]:
    """Split a paragraph into sentences. See module docstring for the
    abbreviation-splitting limitation."""
    sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(paragraph.strip()) if s.strip()]
    return sentences or [paragraph.strip()]


def _apply_casing(template: str, override_part: str, is_first: bool) -> str:
    """Re-apply the original word's casing to an override syllable.

    Only the first syllable can plausibly carry capitalization (e.g. a
    sentence-initial "Over" -> "O" + "ver"); later syllables just follow
    the override table's own casing.
    """
    if is_first and template[:1].isupper():
        return override_part[:1].upper() + override_part[1:]
    return override_part


def _syllabify_word(word: str) -> list[str]:
    """Return written syllable breaks for a single word (no punctuation)."""
    if not word:
        return [word]

    override = SYLLABLE_OVERRIDES.get(word.lower())
    if override is not None:
        return [
            _apply_casing(word, part, is_first=(i == 0))
            for i, part in enumerate(override)
        ]

    hyphenated = dic.inserted(word)
    parts = hyphenated.split("-")
    return parts if parts else [word]


def syllabify(passage: str) -> list[dict]:
    """Turn raw passage text into the flat syllable list described above.

    Paragraphs are split on blank lines; each paragraph is split into
    sentences; words within a sentence are split on whitespace. word_idx
    keeps counting across sentence boundaries (paragraph-relative, as
    before) -- only sentence_idx resets per paragraph.
    """
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", passage.strip()) if p.strip()]

    flat: list[Syllable] = []
    for p_idx, paragraph in enumerate(paragraphs):
        w_idx = 0
        for sent_idx, sentence in enumerate(_split_sentences(paragraph)):
            for token in sentence.split():
                match = _WORD_RE.match(token)
                lead, core, trail = match.groups() if match else ("", token, "")
                syl_parts = _syllabify_word(core) if core else [token]

                # Reattach punctuation to the first/last syllable of the word.
                if lead:
                    syl_parts[0] = lead + syl_parts[0]
                if trail:
                    syl_parts[-1] = syl_parts[-1] + trail

                for s_idx, text in enumerate(syl_parts):
                    flat.append(
                        Syllable(
                            text=text,
                            paragraph_idx=p_idx,
                            sentence_idx=sent_idx,
                            word_idx=w_idx,
                            syllable_idx=s_idx,
                            is_first_in_word=(s_idx == 0),
                            is_last_in_word=(s_idx == len(syl_parts) - 1),
                        )
                    )
                w_idx += 1

    return [asdict(s) for s in flat]
