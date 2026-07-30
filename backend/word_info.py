"""Tap-word lookup pipeline.

Powers POST /api/word-info and POST /api/word-example -- the backend half
of the reading pane's tap-to-define feature (tap a word, cycle through
pronunciation -> definition -> morphology (if useful) -> hear-aloud -> AI
example sentence). See frontend/lib/useTapWord.ts for the tap-cycling
state machine this feeds, and frontend/lib/types.ts's WordInfo for the
combined shape the frontend ends up rendering.

Split two ways:
1. "Fact" vs "generated content" (as with the rest of this backend):
   pronunciation and definition come from a real dictionary
   (dictionaryapi.dev, free, no key) so they're accurate, not
   hallucinated.
2. FAST vs SLOW. get_word_info_quick answers everything that's either
   real dictionary data or a SAFE deterministic rule -- no LLM call --
   which is the raw IPA, the definition, the morphology breakdown (if
   any), and hear-aloud (needs no data at all). Respelling and the
   example sentence both go through the background get_word_example
   call instead.

   Respelling specifically used to be rule-based here too (a plain
   IPA-symbol substitution table), on the theory that IPA -> friendly
   spelling is basically mechanical. Real dictionaryapi.dev data proved
   that wrong two ways: (a) it almost never includes syllable-separating
   dots, so there's no reliable place to put hyphens without real
   syllabification, and the naive fallback (treat the whole word as one
   syllable) produced ugly, hard-to-read all-caps blobs; (b) it uses IPA
   symbols a plain "textbook" table doesn't cover -- e.g. "preview" comes
   back as /ˈpɹiːvjʉː/, using ɹ (not r) and ʉ (not u), and an unmapped
   symbol was silently DROPPED rather than approximated, so the r-sound
   vanished entirely and the respelling ("PEEVY") didn't even sound like
   the word. That's a correctness bug, not just a rough edge -- so
   respelling moved to Claude (still grounded in the real IPA when one
   exists), same call that already generates the example sentence.
   respell_from_ipa() is kept below purely as a last-resort fallback if
   that call ever comes back without one.

   The frontend fires both requests the moment a word is tapped (see
   useTapWord.ts). Raw IPA, definition, morphology, and hear-aloud show
   immediately; the friendly respelling (a small piece of the
   pronunciation stage) and the example sentence (the whole last stage)
   fill in a beat later once the background call resolves -- still a
   real win over the original design where the WHOLE card waited on one
   Claude round trip, just an honest one instead of an all-or-nothing
   claim.

   Fallback: if dictionaryapi.dev has genuinely nothing for a word
   (proper nouns, slang, typos), get_word_example also asks Claude for
   best-effort ipa/definition in that same background call, and backfills
   _quick_cache with them so a repeat tap doesn't pay for that twice.

3. Word-sense disambiguation. dictionaryapi.dev returns a word's
   definitions grouped by meaning (roughly, part of speech), and most
   words genuinely used in a passage have more than one -- e.g.
   "consistent" has senses along the lines of "always acting the same
   way" and "compatible with something else." The original
   implementation just took the FIRST definition of the FIRST meaning
   with zero regard for the sentence the word was tapped from, so a
   sentence using the "steadfast effort" sense could easily surface the
   "compatible with" one instead -- confusing, not just imprecise, for
   the struggling readers this tool is for.

   Fixed two ways, matching the fast/slow split above:
   - FAST: _fetch_dictionary_entry_exact now collects every candidate
     definition (not just the first), and get_word_info_quick picks
     whichever candidate shares the most non-trivial words with the
     tapped sentence (_pick_best_definition) -- a cheap, deterministic,
     no-LLM heuristic that's right more often than "just take the
     first one," and costs nothing extra since the dictionary response
     already contains every candidate.
   - SLOW: the background get_word_example call now always also
     confirms/corrects the definition, this time with real language
     understanding of the sentence -- it's handed the same candidate
     list (cached from the quick fetch so this doesn't cost a second
     dictionary round trip) and told to pick whichever one actually
     fits, or write its own if genuinely none do. The result patches
     into the card a beat later exactly the way respelling already
     does -- see get_word_example's docstring.
"""

import os
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor

import httpx
from anthropic import Anthropic

DICTIONARY_API_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/{word}"

# Kept short deliberately -- this is a live, on-the-spot tap-to-define
# lookup, not a batch job. A slow/unresponsive dictionaryapi.dev should
# fail fast into the Claude-only fallback rather than making a student
# wait on the full 5s+ a more lenient timeout would allow.
_DICTIONARY_TIMEOUT_S = 2.5

# Same idea as syllabify.py's _WORD_RE: strip surrounding punctuation so
# "hallucinate," or "(dog." look up cleanly. Unlike syllabify.py we don't
# need to reattach the punctuation afterward -- this is a lookup key, not
# something rendered back into the passage.
_STRIP_RE = re.compile(r"^\W+|\W+$", re.UNICODE)

_anthropic_client: Anthropic | None = None


def _get_anthropic_client() -> Anthropic:
    """Lazily construct the Anthropic client so importing this module
    doesn't require ANTHROPIC_API_KEY to already be set (e.g. at FastAPI
    startup, before main.py's load_dotenv() has necessarily run in every
    process-start order) -- only actually calling a generate_* function
    does.

    Explicitly strips the key rather than letting the SDK pick up
    os.environ["ANTHROPIC_API_KEY"] on its own -- a stray trailing
    newline in a .env file (easy to introduce depending on how the file
    gets edited/pasted into) becomes part of the header value verbatim
    otherwise, and httpx rejects it outright with
    `LocalProtocolError: Illegal header value`, which the SDK then wraps
    in a generic APIConnectionError that gives no hint it was ever a key
    formatting problem rather than a real connectivity one.
    """
    global _anthropic_client
    if _anthropic_client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
        _anthropic_client = Anthropic(api_key=api_key)
    return _anthropic_client


def clean_word(token: str) -> str:
    """Strip surrounding punctuation and lowercase, e.g. '"Hallucinate,'
    -> 'hallucinate'. Returns '' for a token that's punctuation only."""
    return _STRIP_RE.sub("", token).lower()


def _stem_candidates(word: str) -> list[str]:
    """Naive English stemming for a handful of common inflections --
    NOT a real lemmatizer, just enough to catch the cases that actually
    show up constantly in reading passages: plurals and simple verb
    conjugations. e.g. "jumps" -> "jump", "flies" -> "fly", "hiking" ->
    "hike". Ordered most-specific-suffix-first so "flies" tries "fly"
    before the more generic "-s" stripping would mangle it into "flie"."""
    candidates = []
    if word.endswith("ies") and len(word) > 4:
        candidates.append(word[:-3] + "y")
    if word.endswith("es") and len(word) > 3:
        candidates.append(word[:-2])
    if word.endswith("s") and not word.endswith("ss") and len(word) > 3:
        candidates.append(word[:-1])
    if word.endswith("ing") and len(word) > 5:
        candidates.append(word[:-3])
        candidates.append(word[:-3] + "e")  # "hiking" -> "hike"
    if word.endswith("ed") and len(word) > 4:
        candidates.append(word[:-1])  # "hiked" -> "hike"
        candidates.append(word[:-2])  # "jumped" -> "jump"
    return candidates


_MAX_DEFINITION_CANDIDATES = 10


def _fetch_dictionary_entry_exact(word: str) -> dict | None:
    """One lookup against dictionaryapi.dev for the exact string given --
    no stemming. Returns
    {"ipa": str | None, "definition": str | None, "definitions": [...]}
    on success, or None on a 404/network/parse failure. `definition` is
    just `definitions[0]["definition"]` for callers (e.g.
    analyze_morphology) that only care whether ANY definition exists;
    `definitions` is every candidate found (across every meaning/part of
    speech, up to _MAX_DEFINITION_CANDIDATES), which is what makes
    context-dependent sense selection possible upstream in
    get_word_info_quick/get_word_example -- see the module docstring's
    "Word-sense disambiguation" section. Note that a successful entry
    frequently still has ipa=None -- dictionaryapi.dev's Wiktionary-
    sourced data quite often has a definition but an EMPTY phonetics
    array (e.g. the word "hallucinate" itself has none at all), so
    callers can't treat "entry found" as "pronunciation found"."""
    try:
        resp = httpx.get(DICTIONARY_API_URL.format(word=word), timeout=_DICTIONARY_TIMEOUT_S)
        if resp.status_code != 200:
            return None
        entries = resp.json()
        if not entries:
            return None
    except (httpx.HTTPError, ValueError):
        return None

    ipa = None
    definitions: list[dict] = []
    for entry in entries:
        if ipa is None:
            for phonetic in entry.get("phonetics", []):
                text = phonetic.get("text")
                if text:
                    ipa = text
                    break
            if ipa is None and entry.get("phonetic"):
                ipa = entry["phonetic"]
        for meaning in entry.get("meanings", []):
            part_of_speech = meaning.get("partOfSpeech") or ""
            for d in meaning.get("definitions", []):
                if d.get("definition") and len(definitions) < _MAX_DEFINITION_CANDIDATES:
                    definitions.append(
                        {"definition": _format_definition(d["definition"]), "part_of_speech": part_of_speech}
                    )
        if ipa is not None and len(definitions) >= _MAX_DEFINITION_CANDIDATES:
            break

    if ipa is None and not definitions:
        return None
    return {
        "ipa": ipa,
        "definition": definitions[0]["definition"] if definitions else None,
        "definitions": definitions,
    }


def fetch_dictionary_entry(word: str) -> dict | None:
    """Look up `word` against dictionaryapi.dev, the way callers actually
    want it to behave: try the word exactly as given, and fall back to a
    few naive stemmed variants if that comes back empty.
    dictionaryapi.dev frequently only has an entry for the BASE form of a
    word, not the inflected form that actually shows up in a passage --
    e.g. "jump" has an entry, "jumps" often doesn't -- so without this,
    perfectly ordinary conjugated/plural words would silently fall
    through to the Claude fallback instead of real dictionary data,
    defeating the point of using a dictionary at all. Returns None only
    if nothing -- exact or stemmed -- was found.

    The exact form and every stemmed candidate are fired CONCURRENTLY,
    not tried one at a time. Sequentially, a word needing 2-3 stemmed
    attempts (not unusual -- "jumping" alone generates two candidates)
    paid for 2-3 full round trips back to back, each up to the dictionary
    timeout on a miss. ThreadPoolExecutor.map preserves input order in
    its results, so the preference order (exact match wins if present,
    otherwise the first stemmed candidate that resolved, most-specific-
    suffix-first) is identical to a sequential version -- only the
    wall-clock cost changes, from "sum of every attempt" to "the slowest
    single attempt."
    """
    candidates = [word] + _stem_candidates(word)
    with ThreadPoolExecutor(max_workers=len(candidates)) as pool:
        results = list(pool.map(_fetch_dictionary_entry_exact, candidates))
    for entry in results:
        if entry is not None:
            return entry
    return None


# --- Word-sense selection (fast, rule-based heuristic) -----------------
#
# Picks whichever candidate definition shares the most non-trivial words
# with the sentence the word was tapped from -- a cheap stand-in for real
# semantic understanding that's meaningfully better than "always the
# first one," and needs no network/LLM call so it stays on the fast
# path. The background Claude call in get_word_example double-checks
# this with actual language understanding a beat later; see the module
# docstring.

_STOPWORDS = frozenset(
    """
    a an the and or but if of to in on at for with as by from into onto
    is are was were be been being it its it's this that these those he
    she they them his her their our your my i you we me him us do does
    did not no so than then there here up down out over under again
    further once here there when where why how all any both each few
    more most other some such only own same so than too very can will
    just should now
    """.split()
)

_WORD_TOKEN_RE = re.compile(r"[a-z']+")


def _content_words(text: str) -> set[str]:
    return {w for w in _WORD_TOKEN_RE.findall(text.lower()) if w and w not in _STOPWORDS and len(w) > 2}


def _format_definition(text: str) -> str:
    """House style for a displayed definition: no capital first letter,
    no trailing period -- e.g. "to constantly act or perform in the same
    way over time" rather than "To constantly act or perform in the same
    way over time." (matches how dictionaries conventionally style a
    definition meant to read as a clause, not a standalone sentence).
    Applied once at the point a definition enters the system -- both
    dictionaryapi.dev's candidates (in _fetch_dictionary_entry_exact) and
    Claude's own invented ones (in get_word_example, as a defensive
    normalization in case the model doesn't follow the style instruction
    exactly) -- so every caller downstream can assume the same shape
    without re-checking it. Only strips ONE trailing period (plus any
    trailing whitespace), not every trailing character, so it doesn't
    mangle a definition that legitimately ends with an abbreviation like
    "etc." followed by the real terminal period."""
    if not text:
        return text
    stripped = text.strip()
    stripped = re.sub(r"\.+\s*$", "", stripped)
    if not stripped:
        return stripped
    return stripped[0].lower() + stripped[1:]


def _pick_best_definition(candidates: list[dict], sentence: str) -> str:
    """`candidates` is the `definitions` list from _fetch_dictionary_entry_exact
    (already ordered by dictionary preference). Returns "" if `candidates`
    is empty. Falls back to the first (dictionary-preferred) candidate
    whenever the sentence doesn't clearly favor a different one --
    scoring every candidate 0 (e.g. an unusually short/generic sentence)
    is common and shouldn't be treated as a signal to pick something
    other than the dictionary's own default ordering."""
    if not candidates:
        return ""
    sentence_words = _content_words(sentence)
    if not sentence_words:
        return candidates[0]["definition"]

    best_idx = 0
    best_score = -1
    for i, candidate in enumerate(candidates):
        score = len(_content_words(candidate["definition"]) & sentence_words)
        if score > best_score:
            best_score = score
            best_idx = i
    if best_score <= 0:
        return candidates[0]["definition"]
    return candidates[best_idx]["definition"]


# --- Rule-based respelling (fallback only, not the primary path) ------
#
# See the module docstring for why this is no longer what generates the
# respelling shown to students -- it's kept as a last-resort fallback for
# the rare case the background Claude call doesn't return one. Covers the
# common English IPA phonemes AND the specific symbol variants
# dictionaryapi.dev's real data actually uses (ɹ, ʉ, ɚ, ɡ, tied
# affricates like t͡ʃ), verified against live API responses for
# "hallucinate", "preview", "elephant", "happy", "adventure", and
# "important" while diagnosing the bug that moved respelling off this
# path in the first place.

_STRESS_MARKS = "ˈˌ"


def _strip_combining_marks(s: str) -> str:
    """Drops Unicode combining marks (category Mn) -- notably the tie-bar
    some IPA sources use to mark affricates as one unit (e.g. t + tie-bar
    + sh) instead of writing the two letters plain. Stripping it first
    means that normalizes to plain digraph form and hits the existing
    table entry below, rather than falling through to a lone consonant +
    an unrecognized combining mark. Stress marks and the length mark are
    modifier letters (category Lm), not combining marks, so this never
    touches stress/length marking."""
    return "".join(ch for ch in s if not unicodedata.combining(ch))

# Longest-match-first: multi-character IPA sequences (diphthongs, r-colored
# vowels, affricates, digraphs) must be checked before their component
# single characters, or e.g. "eɪ" would get chopped into "e" + "ɪ".
_IPA_REPLACEMENTS: list[tuple[str, str]] = [
    ("eɪ", "ay"),
    ("aɪ", "eye"),
    ("ɔɪ", "oy"),
    ("aʊ", "ow"),
    ("oʊ", "oh"),
    ("ɪər", "eer"),
    ("ɛər", "air"),
    ("ʊər", "oor"),
    ("ɑːr", "ar"),
    ("ɔːr", "or"),
    ("ɜːr", "ur"),
    ("ɔɹ", "or"),
    ("ɑɹ", "ar"),
    ("ɪɹ", "eer"),
    ("ɛɹ", "air"),
    ("iː", "ee"),
    ("uː", "oo"),
    ("ɑː", "ah"),
    ("ɔː", "aw"),
    ("ɜː", "ur"),
    ("tʃ", "ch"),
    ("dʒ", "j"),
    ("ʃ", "sh"),
    ("ʒ", "zh"),
    ("θ", "th"),
    ("ð", "th"),
    ("ŋ", "ng"),
    ("ɹ", "r"),  # the symbol dictionaryapi.dev actually uses for English r, not plain "r"
    ("ʉ", "oo"),  # fronted "u" variant seen in some entries
    ("ɚ", "er"),  # rhotacized schwa, e.g. the end of "adventure"
    ("ɝ", "ur"),  # stressed rhotacized vowel, e.g. "bird"
    ("ɡ", "g"),  # IPA script-g codepoint, distinct from ASCII "g"
    ("ʔ", ""),  # glottal stop -- no clean English-spelling equivalent, drop silently
    ("j", "y"),
    ("ɪ", "ih"),
    ("ʊ", "uu"),
    ("ʌ", "uh"),
    ("ə", "uh"),
    ("æ", "a"),
    ("ɛ", "eh"),
    ("ɒ", "ah"),
    ("ɔ", "aw"),
    ("e", "eh"),
    ("ɑ", "ah"),
    ("i", "ee"),
    ("u", "oo"),
    ("o", "oh"),
    ("a", "ah"),
    ("r", "r"),
    ("l", "l"),
    ("w", "w"),
    ("h", "h"),
    ("m", "m"),
    ("n", "n"),
    ("p", "p"),
    ("b", "b"),
    ("t", "t"),
    ("d", "d"),
    ("k", "k"),
    ("g", "g"),
    ("f", "f"),
    ("v", "v"),
    ("s", "s"),
    ("z", "z"),
]


def _respell_syllable(syl: str) -> str:
    out = []
    i = 0
    while i < len(syl):
        matched = False
        for ipa_seq, respell in _IPA_REPLACEMENTS:
            if syl.startswith(ipa_seq, i):
                out.append(respell)
                i += len(ipa_seq)
                matched = True
                break
        if not matched:
            i += 1  # unrecognized character (stray diacritic, etc.) -- skip it
    return "".join(out) if out else syl


def respell_from_ipa(ipa: str) -> str:
    """Rule-based IPA -> friendly respelling -- fallback path only, see
    the module docstring. Returns "" for empty input rather than
    guessing. In practice dictionaryapi.dev's IPA strings essentially
    never include syllable-separating dots, so real syllabification
    isn't available here; when dots ARE present each syllable is
    respelled and hyphenated separately, and otherwise the whole
    transcription is respelled as one continuous (lowercase, not
    all-caps) string with the stress mark's position dropped rather than
    faked -- deliberately not capitalizing an arbitrary whole chunk,
    which is what produced unreadable all-caps blobs before this was
    diagnosed."""
    if not ipa:
        return ""
    stripped = ipa.strip().strip("/[]")
    stripped = _strip_combining_marks(stripped)
    if not stripped:
        return ""

    if "." in stripped:
        syllables = stripped.split(".")
        respelled = []
        stressed_index = 0
        for i, syl in enumerate(syllables):
            if "ˈ" in syl:
                stressed_index = i
            clean_syl = syl
            for mark in _STRESS_MARKS:
                clean_syl = clean_syl.replace(mark, "")
            respelled.append(_respell_syllable(clean_syl))
        if not respelled:
            return stripped
        respelled[stressed_index] = respelled[stressed_index].upper()
        return "-".join(respelled)

    # No syllable dots (the common case for this data source) -- respell
    # continuously rather than guessing where syllable breaks are.
    clean = stripped
    for mark in _STRESS_MARKS:
        clean = clean.replace(mark, "")
    return _respell_syllable(clean)


# --- Rule-based morphology breakdown (no LLM) -------------------------
#
# Strips a recognized prefix/suffix and only calls it "useful" when the
# remaining root is independently verifiable as a real word via the
# dictionary (reusing _fetch_dictionary_entry_exact) -- that verification
# step is what stops this from guessing wrong on opaque words that merely
# happen to start with prefix-shaped letters (e.g. "hallucinate" does not
# start with a recognized prefix here, but even if it superficially
# resembled one, the dictionary check would reject a bogus root).
_PREFIXES: list[tuple[str, str]] = [
    ("un", "not"),
    ("re", "again"),
    ("pre", "before"),
    ("dis", "opposite of"),
    ("mis", "wrongly"),
    ("non", "not"),
    ("over", "too much"),
    ("under", "not enough"),
    ("sub", "below"),
    ("super", "above/beyond"),
    ("inter", "between"),
    ("anti", "against"),
    ("semi", "half"),
    ("post", "after"),
    ("co", "together"),
    ("im", "not"),
    ("in", "not"),
    ("il", "not"),
    ("ir", "not"),
]

_SUFFIXES: list[tuple[str, str]] = [
    ("tion", "the act/result of"),
    ("sion", "the act/result of"),
    ("ment", "the result of"),
    ("ness", "the state of being"),
    ("ful", "full of"),
    ("less", "without"),
    ("able", "able to be"),
    ("ible", "able to be"),
    ("ous", "full of"),
    ("ive", "tending to"),
    ("al", "relating to"),
    ("ing", ""),
    ("ed", ""),
    ("ly", "in a way that is"),
]


def analyze_morphology(word: str) -> dict | None:
    """Rule-based prefix/suffix breakdown. Returns
    {"parts": [...], "note": "..."} or None (not useful/no match) --
    None is exactly what makes useTapWord.ts skip the morphology stage
    for this word, matching the original "only show it when it
    genuinely helps" design."""
    for prefix, gloss in _PREFIXES:
        if word.startswith(prefix) and len(word) > len(prefix) + 2:
            root = word[len(prefix):]
            if _fetch_dictionary_entry_exact(root) is not None:
                return {"parts": [prefix, root], "note": f"{prefix}- ({gloss}) + {root}"}
    for suffix, gloss in _SUFFIXES:
        if word.endswith(suffix) and len(word) > len(suffix) + 2:
            root = word[: -len(suffix)]
            root_candidates = [root]
            if suffix in ("ing", "ed"):
                root_candidates.append(root + "e")  # "hiking" -> "hik" -> "hike"
            for candidate in root_candidates:
                if _fetch_dictionary_entry_exact(candidate) is not None:
                    gloss_part = f" ({gloss})" if gloss else ""
                    return {"parts": [candidate, suffix], "note": f"{candidate} + -{suffix}{gloss_part}"}
    return None


# --- Fast path: dictionary + rules, no LLM ----------------------------

# Process-lifetime caches. Not persisted to disk/a database on purpose:
# this backend is architecturally stateless (see README.md) -- this is a
# pure speed optimization, safe to lose on restart, not a source of
# truth.
#
# Split into WORD-only facts and (WORD, SENTENCE)-dependent facts, since
# those genuinely have different lifetimes: a word's dictionary entry
# (raw ipa + every candidate definition) and its morphology breakdown
# don't depend on which sentence it was tapped from, so those stay keyed
# by word alone and get reused across every sentence that word shows up
# in -- no reason to pay for another dictionary round trip just because
# the same word appears twice in a passage. Which DEFINITION fits, on
# the other hand, is exactly the thing that's supposed to change with
# context (see the module docstring's "Word-sense disambiguation"
# section), so _quick_cache and _example_cache -- and therefore the
# `definition` (and `respelling`/`example_sentence`, generated alongside
# it) they hold -- are keyed by (word, sentence) together. A repeat tap
# of the same word in the SAME sentence still hits cache instantly, same
# as before; the same word met again in a DIFFERENT sentence now
# correctly re-evaluates instead of silently reusing a possibly
# wrong-for-this-context answer from earlier in the passage.
_dictionary_cache: dict[str, dict] = {}
_morphology_cache: dict[str, dict | None] = {}
_MORPHOLOGY_MISSING = object()  # sentinel: "not computed yet" (None is a valid, cached result)

_quick_cache: dict[tuple[str, str], dict] = {}
_example_cache: dict[tuple[str, str], dict] = {}


def get_word_info_quick(word: str, sentence: str) -> dict:
    """Fast path: dictionary lookup + rule-based morphology. NO Claude
    call -- this is what makes the raw pronunciation (IPA), definition,
    morphology, and hear-aloud available essentially instantly for any
    word the dictionary has. Powers POST /api/word-info.

    `definition` is picked via _pick_best_definition -- a fast, rule-based
    best guess at which of the dictionary's candidate senses fits this
    sentence, not just the first one dictionaryapi.dev happens to list.
    It's still just a heuristic, though; get_word_example's background
    Claude call confirms/corrects it a beat later with real language
    understanding (see the module docstring's "Word-sense
    disambiguation" section) the same way it already does for respelling.

    `respelling`/`example_sentence` come back as "" here -- the frontend
    fetches those separately via get_word_example (POST /api/word-example,
    fired in parallel at tap time) and patches them in once that
    resolves, since both genuinely need Claude's judgment (see the module
    docstring for why respelling moved off the rule-based path)."""
    cleaned = clean_word(word)
    if not cleaned:
        cleaned = word.strip().lower()

    cache_key = (cleaned, sentence)
    cached = _quick_cache.get(cache_key)
    if cached is not None:
        return cached

    dictionary_entry = _dictionary_cache.get(cleaned)
    if dictionary_entry is None:
        dictionary_entry = fetch_dictionary_entry(cleaned) or {}
        _dictionary_cache[cleaned] = dictionary_entry

    ipa = dictionary_entry.get("ipa") or ""
    candidates = dictionary_entry.get("definitions") or []
    definition = _format_definition(_pick_best_definition(candidates, sentence))

    morphology = _morphology_cache.get(cleaned, _MORPHOLOGY_MISSING)
    if morphology is _MORPHOLOGY_MISSING:
        morphology = analyze_morphology(cleaned) if cleaned else None
        _morphology_cache[cleaned] = morphology

    result = {
        "word": cleaned,
        "ipa": ipa,
        "respelling": "",
        "definition": definition,
        "morphology": morphology,
        "example_sentence": "",
    }
    _quick_cache[cache_key] = result
    return result


# --- Slow path: the fields that genuinely need Claude ------------------

_ENRICH_TOOL = {
    "name": "word_enrich",
    "description": "Friendly respelling and a new example sentence for one word, plus best-effort ipa/definition if asked for.",
    "input_schema": {
        "type": "object",
        "properties": {
            "respelling": {
                "type": "string",
                "description": (
                    "Friendly syllable-stress respelling grounded in the given ipa "
                    "(or your own best-effort ipa if none was given), e.g. "
                    "'huh-LOO-sih-nayt' for \"hallucinate\" -- capitalize the "
                    "stressed syllable, hyphenate the rest."
                ),
            },
            "example_sentence": {
                "type": "string",
                "description": (
                    "One natural, grade 7-12-appropriate sentence using the word in "
                    "a similar sense to the context sentence provided -- not the "
                    "context sentence itself, a new one."
                ),
            },
            "ipa": {
                "type": "string",
                "description": "Best-effort IPA pronunciation. Only include this if asked for below.",
            },
            "definition": {
                "type": "string",
                "description": (
                    "The single definition that best matches how the word is used in "
                    "the given sentence. If a numbered list of dictionary candidates is "
                    "provided in the prompt, copy your chosen candidate's text verbatim "
                    "rather than paraphrasing it -- pick by meaning, not by which is "
                    "listed first. If no candidates fit (or none were provided), write "
                    "your own grade 7-12-appropriate definition instead. House style "
                    "either way: no capital letter at the start, no period at the end "
                    "-- e.g. 'to constantly act or perform in the same way over time', "
                    "not 'To constantly act or perform in the same way over time.'"
                ),
            },
        },
        "required": ["respelling", "example_sentence", "definition"],
    },
}


def _generate_enrichment(
    word: str, sentence: str, known_ipa: str, need_ipa: bool, candidate_definitions: list[dict]
) -> dict:
    """The one background Claude call per word: always a respelling, a
    new example sentence, and a context-checked definition, plus a
    best-effort ipa when dictionaryapi.dev didn't have one (a common
    partial case, not a rare one -- see the module docstring).

    The definition is asked for every time now, not just when the
    dictionary had nothing -- dictionaryapi.dev usually returns several
    candidate senses for a word, and get_word_info_quick's fast
    word-overlap heuristic (_pick_best_definition) is only a rough first
    guess at which one fits this sentence. This call is what actually
    confirms or corrects that guess with real language understanding,
    the same "instant guess now, Claude patches it a beat later" pattern
    already used for respelling. See the module docstring's "Word-sense
    disambiguation" section."""
    known = []
    if known_ipa:
        known.append(f'Real dictionary IPA: "{known_ipa}" -- ground the respelling in this exactly.')

    need_definition = not candidate_definitions
    if candidate_definitions:
        numbered = "\n".join(
            f'{i + 1}. ({c["part_of_speech"] or "unlabeled"}) {c["definition"]}'
            for i, c in enumerate(candidate_definitions)
        )
        known.append(
            "Dictionary definitions to choose from (pick whichever one matches how the "
            f"word is actually used in the sentence above -- not necessarily #1):\n{numbered}"
        )

    asks = ["a friendly respelling", "a new example sentence"]
    if need_ipa:
        asks.append("your own best-effort ipa (no dictionary pronunciation was found for this word)")
    if need_definition:
        asks.append("your own best-effort definition (no dictionary definition was found for this word)")
    else:
        asks.append("the best-fitting definition for this sentence, from the numbered candidates above")

    prompt = (
        f'Word: "{word}"\n'
        f'Sentence it was tapped from: "{sentence}"\n\n'
        + "\n".join(known)
        + "\n\nProvide: "
        + ", ".join(asks)
        + ".\n\nThis is for a grade 7-12 student using a reading-fluency tool. "
        "Call the word_enrich tool."
    )
    client = _get_anthropic_client()
    response = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=512,
        tools=[_ENRICH_TOOL],
        tool_choice={"type": "tool", "name": "word_enrich"},
        messages=[{"role": "user", "content": prompt}],
    )
    tool_use = next(b for b in response.content if b.type == "tool_use")
    return tool_use.input


def get_word_example(word: str, sentence: str) -> dict:
    """Slow path: the fields that genuinely need Claude. Fetched by the
    frontend in parallel with get_word_info_quick (see useTapWord.ts),
    and merged into the card once it resolves -- raw pronunciation/
    definition/morphology/hear-aloud are already showable by the time
    this lands, so only the respelling (a small piece of stage 1) and the
    example sentence (all of stage 5) are ever waiting on it. Powers
    POST /api/word-example.

    Always returns {"respelling", "example_sentence", "definition"} --
    `definition` is Claude's context-checked pick/correction of
    get_word_info_quick's fast word-overlap guess (see the module
    docstring's "Word-sense disambiguation" section), not just a
    fallback for words the dictionary had nothing for, so the frontend's
    existing merge-on-resolve (see useTapWord.ts's fetchExampleOnly)
    already overwrites whatever the quick heuristic guessed with the
    confirmed one once this resolves -- no frontend change needed. In
    the common partial case (dictionary had a definition but no
    phonetics, e.g. "hallucinate" itself) also returns "ipa" -- and
    backfills both _quick_cache (this exact word+sentence) and
    _dictionary_cache (this word, every sentence) with the invented ipa,
    so neither this function nor a fresh dictionary lookup has to run
    again for the same gap. `definition`/`respelling`/`example_sentence`
    are cached per (word, sentence) -- see _quick_cache's comment --
    since which sense fits, and the example illustrating it, are exactly
    the things that should change if the same word shows up again in a
    different sentence."""
    cleaned = clean_word(word)
    if not cleaned:
        cleaned = word.strip().lower()

    quick = get_word_info_quick(cleaned, sentence)  # cache hit in the common case -- this already ran for /api/word-info moments earlier

    cache_key = (cleaned, sentence)
    cached = _example_cache.get(cache_key)
    if cached is not None:
        return cached

    need_ipa = not quick["ipa"]
    dictionary_entry = _dictionary_cache.get(cleaned) or {}
    candidates = dictionary_entry.get("definitions") or []

    data = _generate_enrichment(cleaned, sentence, quick["ipa"], need_ipa, candidates)

    ipa_for_respelling = data.get("ipa") if need_ipa else quick["ipa"]
    respelling = data.get("respelling") or respell_from_ipa(ipa_for_respelling)
    definition = _format_definition(data.get("definition") or quick["definition"])

    result: dict = {
        "respelling": respelling,
        "example_sentence": data.get("example_sentence", ""),
        "definition": definition,
    }
    if need_ipa:
        result["ipa"] = data.get("ipa", "")

    _example_cache[cache_key] = result

    updated = dict(quick)
    updated["definition"] = definition
    if need_ipa:
        updated["ipa"] = result["ipa"]
    _quick_cache[cache_key] = updated

    # ipa is a word-level fact (not sentence-dependent) -- backfill it
    # into the word-only dictionary cache too, so a DIFFERENT sentence
    # later in the passage gets this word's ipa for free instead of
    # asking Claude to invent it again.
    if need_ipa and result["ipa"]:
        backfilled_entry = dict(dictionary_entry)
        backfilled_entry["ipa"] = result["ipa"]
        _dictionary_cache[cleaned] = backfilled_entry

    return result
