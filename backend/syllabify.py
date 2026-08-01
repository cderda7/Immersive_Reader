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

SENTENCE SPLITTING is a punctuation heuristic (see _split_sentences below),
not real sentence-boundary detection. It specifically tolerates two cases
that come up constantly in real book text: a short list of common
abbreviations (Mr., Dr., e.g., etc. -- see _ABBREVIATIONS) doesn't trigger
a split, and a closing quote/paren/bracket is allowed to sit between the
terminal punctuation and the whitespace (so dialogue like `"Stop!" she
said.` splits sensibly instead of the quote blocking the split entirely).
It's still a heuristic, not a parser -- unusual punctuation or an
abbreviation outside the hardcoded list can still mis-split.

TEXT NORMALIZATION: real book text (e.g. Project Gutenberg downloads,
copy-pasted from Word/Docs/Pages) commonly uses curly "smart" quotes/
apostrophes and en/em dashes instead of the plain ASCII versions.
_normalize_punctuation() maps these to straight equivalents once, up
front, before any tokenizing happens -- so _WORD_RE below only ever has
to handle plain ASCII punctuation, and doesn't need its own Unicode-quote
handling.

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
That's exactly how later entries like "ago" got added: not from the sweep
above, but from reading real book text (Moby Dick ch. 1) and catching a
miss the frequency list alone didn't surface.

PUNCTUATION-ONLY TOKENS (e.g. a bare "--" used as a parenthetical aside, or
the standalone "-" that the en/em-dash mapping above produces) are never
emitted as their own syllable/"word" -- see the `pending_prefix` handling
in syllabify() below. A token with no word characters at all has nothing
for _WORD_RE's lead/trail groups to attach to, so rendering it standalone
would make it look and advance like a real syllable when it isn't one.
Instead its text is carried forward and prepended onto the NEXT real
word's leading edge (so it reads attached to the syllable that follows
it, the same direction a reader's eye carries a mid-sentence dash) or, if
nothing follows it in the paragraph, appended onto the END of the last
syllable already emitted, so it's never silently dropped either way.
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
    "ago": ["a", "go"],
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
# syllable it's attached to instead of getting syllabified itself. Relies
# on _normalize_punctuation() having already run -- this only recognizes
# straight ASCII '/- as part of a word, not curly quotes.
_WORD_RE = re.compile(r"^(\W*)([\w'-]*)(\W*)$", re.UNICODE)

# Curly quotes/apostrophes and en/em dashes -> plain ASCII equivalents.
# Applied once, up front (see _normalize_punctuation), not per-regex, so
# every downstream pattern (_WORD_RE, _SENTENCE_BOUNDARY_RE) only ever
# sees straight punctuation.
_NORMALIZE_MAP = {
    "‘": "'",  # ‘ left single quote
    "’": "'",  # ’ right single quote / apostrophe
    "‚": "'",  # ‚ low single quote
    "“": '"',  # “ left double quote
    "”": '"',  # ” right double quote
    "„": '"',  # „ low double quote
    # En/em dashes map to a SPACED hyphen, not a bare one -- found by
    # spot-checking real ingested output: real prose commonly runs an
    # em-dash with no surrounding spaces ("Some years ago—never mind
    # how long precisely—having little money..."). Mapped to a bare
    # "-" that reads identically to a real hyphenated compound word
    # ("Sword-Fish"), so "ago" and "never" would silently glue into one
    # fake "ago-never" token -- wrong, but not something the unparsed-
    # token audit catches, since it still parses fine as a hyphenated
    # word. An em-dash is always clause-separating punctuation, never a
    # word-joiner, so it's forced apart from its neighbors here; a real
    # hyphen (already plain ASCII, never touched by this map) keeps
    # joining real compounds exactly as before.
    "–": " - ",  # – en dash
    "—": " - ",  # — em dash
}
_NORMALIZE_RE = re.compile("|".join(_NORMALIZE_MAP))

# Found empirically running this against real Melville/Shakespeare text
# (see backend/ingest_book.py's sanity report): a dash used mid-sentence
# as an interruption/aside is very often glued directly to the PRECEDING
# punctuation with no space at all -- e.g. "Diminish?-Will", "gale.-It's",
# "thing;-no,". Whitespace-tokenizing (see syllabify() below) treats that
# whole glued run as one "word", which _WORD_RE can't parse (it only
# tolerates ONE run of leading punctuation and ONE run of trailing
# punctuation, not punctuation-dash-word in the middle). Inserting a
# space right after the punctuation, before the dash, splits it back
# into two ordinary tokens (each independently parseable) without
# touching a real mid-word hyphen like "Sword-Fish" (only preceded by a
# letter, never by punctuation).
_GLUED_DASH_RE = re.compile(r"(?<=[.,;:!?'\"()])-(?=\w)")

# Sentence boundary: a run of ./!/? optionally followed by a closing
# quote/paren/bracket, then whitespace -- captured as two groups (the
# punctuation-plus-quote, then the whitespace) so _split_sentences can
# decide, per candidate boundary, whether to actually split there (see
# _ABBREVIATIONS below).
_SENTENCE_BOUNDARY_RE = re.compile(r"([.!?]+['\"\)\]]*)(\s+)")

# Common abbreviations that end in a period but don't end a sentence.
# Checked against the token immediately before a candidate boundary (see
# _ends_with_abbreviation) -- deliberately a short, hand-picked list
# rather than an attempt at exhaustive coverage; same "good enough for
# real prose, not a real NLP sentence splitter" trade-off as the rest of
# this heuristic.
_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "st", "jr", "sr", "prof", "capt", "col",
    "gen", "lt", "sgt", "rev", "vs", "etc", "e.g", "i.e",
}


@dataclass
class Syllable:
    text: str
    paragraph_idx: int
    sentence_idx: int
    word_idx: int
    syllable_idx: int
    is_first_in_word: bool
    is_last_in_word: bool


def _normalize_punctuation(text: str) -> str:
    """Map curly quotes/apostrophes and en/em dashes to their plain ASCII
    equivalents, split a dash glued directly to preceding punctuation
    (no space) into its own token, and drop Project Gutenberg's
    underscore-wrapped italics markup (`_word_`, or `[_Aside._]` for a
    stage direction -- both found in the real library texts). The
    underscore itself is invisible formatting, not real punctuation, and
    _WORD_RE treats it as a word character (\\w includes it) -- left in,
    it silently breaks the leading-punctuation/core/trailing-punctuation
    match for anything touching it (e.g. "monument._]" has a \\w char
    AFTER punctuation has already started, which _WORD_RE can't
    express). See module docstring -- this runs once, before any
    tokenizing, so _WORD_RE and the sentence splitter below only ever
    have to handle straight, cleanly-separated punctuation."""
    text = _NORMALIZE_RE.sub(lambda m: _NORMALIZE_MAP[m.group(0)], text)
    text = _GLUED_DASH_RE.sub(" -", text)
    return text.replace("_", "")


def _ends_with_abbreviation(fragment: str) -> bool:
    """True if `fragment` (everything up to and including a candidate
    sentence-boundary's punctuation) ends in a known abbreviation, e.g.
    "...Dr." or "...i.e." -- checked against fragment's last whitespace-
    delimited token, with its own leading/trailing punctuation stripped
    off and lowercased."""
    tokens = fragment.split()
    if not tokens:
        return False
    last_token = tokens[-1].strip("'\"()[].!?").lower()
    return last_token in _ABBREVIATIONS


def _split_sentences(paragraph: str) -> list[str]:
    """Split a paragraph into sentences on terminal punctuation followed
    by whitespace, tolerating a closing quote/paren/bracket in between
    (so dialogue like `"Stop!" she said.` splits sensibly) and skipping
    splits right after a common abbreviation (Mr., Dr., e.g., ...). Still
    a heuristic, not real sentence-boundary detection -- see module
    docstring."""
    paragraph = paragraph.strip()
    sentences: list[str] = []
    pos = 0
    for match in _SENTENCE_BOUNDARY_RE.finditer(paragraph):
        boundary_end = match.end(1)
        candidate = paragraph[pos:boundary_end]
        if _ends_with_abbreviation(candidate):
            continue
        stripped = candidate.strip()
        if stripped:
            sentences.append(stripped)
        pos = match.end()
    tail = paragraph[pos:].strip()
    if tail:
        sentences.append(tail)
    return sentences or [paragraph]


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

    # A word with its OWN internal hyphen -- a real compound like
    # "Sword-Fish" or "self-esteem", common in real prose -- can't be
    # handed to Pyphen as one piece: dic.inserted() uses "-" as its own
    # syllable-break marker, so the word's real hyphen collides with an
    # inserted one (e.g. "Sword-Fish" -> "Sword--Fish"), and splitting
    # on "-" then produces a stray EMPTY syllable at that spot -- which
    # silently vanishes once rendered, turning "Sword-Fish" into
    # "SwordFish". Split on the word's own hyphen(s) first, syllabify
    # each side independently (neither side has an internal hyphen
    # anymore, so there's nothing left to collide), then reattach the
    # original hyphen to the end of the syllable before it.
    if "-" in word:
        sides = word.split("-")
        parts: list[str] = []
        for i, side in enumerate(sides):
            side_parts = _syllabify_word(side) if side else [""]
            if i == 0:
                parts = list(side_parts)
            else:
                parts[-1] = parts[-1] + "-" + side_parts[0]
                parts.extend(side_parts[1:])
        return parts

    hyphenated = dic.inserted(word)
    parts = hyphenated.split("-")
    return parts if parts else [word]


def syllabify(passage: str) -> list[dict]:
    """Turn raw passage text into the flat syllable list described above.

    Paragraphs are split on blank lines; each paragraph is split into
    sentences; words within a sentence are split on whitespace. word_idx
    keeps counting across sentence boundaries (paragraph-relative, as
    before) -- only sentence_idx resets per paragraph. Punctuation is
    normalized to plain ASCII (see _normalize_punctuation) before any of
    that happens.
    """
    passage = _normalize_punctuation(passage)
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", passage.strip()) if p.strip()]

    flat: list[Syllable] = []
    for p_idx, paragraph in enumerate(paragraphs):
        w_idx = 0
        # Holds punctuation-only tokens (see module docstring) until the
        # next real word shows up to attach them to. Scoped per-paragraph
        # (not per-sentence) since a stray dash could in principle be the
        # last token _split_sentences hands back for one sentence, with
        # the actual next word starting the following sentence.
        pending_prefix = ""
        for sent_idx, sentence in enumerate(_split_sentences(paragraph)):
            for token in sentence.split():
                match = _WORD_RE.match(token)
                lead, core, trail = match.groups() if match else ("", token, "")

                if not core:
                    # Whole token is punctuation (e.g. the standalone "-"
                    # left over from em/en-dash normalization, or a bare
                    # "--" aside) -- hold it rather than emit it as its
                    # own fake "word"; it gets prepended onto the next
                    # real word's leading edge below.
                    pending_prefix += lead + trail
                    continue

                if pending_prefix:
                    lead = pending_prefix + lead
                    pending_prefix = ""

                syl_parts = _syllabify_word(core)

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

        if pending_prefix and flat:
            # Nothing followed this punctuation anywhere else in the
            # paragraph -- attach it to the end of the last syllable
            # already emitted instead of dropping it silently.
            flat[-1].text += pending_prefix

    return [asdict(s) for s in flat]
