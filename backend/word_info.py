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

   Respelling used to be handed to Claude alongside the example sentence
   (still grounded in the real IPA when one existed, but ultimately
   free-text the model wrote). That let genuine phonetic mistakes slip
   through with no dictionary backing them -- e.g. "fluency"
   (/ˈfluːənsi/, correctly "FLOO-uhn-see") coming back from Claude as
   "FLOO-un-nee", an invented final syllable that doesn't match the real
   pronunciation at all. That's not acceptable for a tool whose whole
   point is showing struggling readers a TRUSTWORTHY pronunciation, so
   respelling is now rule-based end to end: mechanically derived from
   the real dictionaryapi.dev IPA via respell_from_ipa(), never
   generated/invented by the model. See respell_from_ipa()'s docstring
   for how it syllabifies even the common case where dictionaryapi.dev's
   IPA has no syllable-separating dots (most of them don't) -- earlier
   versions of this function only handled the WITH-dots case correctly
   and fell back to an unhyphenated blob otherwise; it now derives real
   syllable boundaries straight from the IPA's own vowel nuclei using a
   standard maximal-onset rule, so hyphenation and stress placement are
   correct even without dots. Because this no longer needs Claude at
   all, get_word_info_quick can fill in `respelling` immediately
   alongside the IPA whenever the dictionary has one -- no waiting on
   the background call for it anymore. Claude is still asked for its
   own best-effort ipa in the rare case dictionaryapi.dev has none at
   all (see need_ipa below); respelling is then derived from THAT ipa
   the same mechanical way, rather than asked for separately, so it's
   never independently-invented text even in that fallback case.

   The frontend fires both requests the moment a word is tapped (see
   useTapWord.ts). Raw IPA, respelling, definition, morphology, and
   hear-aloud show immediately in the common case; only the example
   sentence (the whole last stage) -- and, for the rare word
   dictionaryapi.dev has nothing on, the ipa/respelling too -- fill in a
   beat later once the background call resolves.

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
     into the card a beat later once the background call resolves --
     see get_word_example's docstring.
"""

import logging
import os
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError

import httpx
from anthropic import Anthropic, APIConnectionError, APIStatusError, APITimeoutError

logger = logging.getLogger(__name__)

DICTIONARY_API_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/{word}"

# Kept short deliberately -- this is a live, on-the-spot tap-to-define
# lookup, not a batch job. A slow/unresponsive dictionaryapi.dev should
# fail fast into the Claude-only fallback rather than making a student
# wait on the full 5s+ a more lenient timeout would allow.
_DICTIONARY_TIMEOUT_S = 2.5

# Belt-and-suspenders on top of _DICTIONARY_TIMEOUT_S above: httpx's own
# `timeout=` kwarg is passed to every dictionaryapi.dev call, but it only
# reliably bounds the parts of the request httpx itself controls. DNS
# resolution goes through the stdlib's blocking socket.getaddrinfo(),
# which has no timeout parameter of its own and isn't reliably
# interruptible -- on some networks (school/corporate VPNs, broken IPv6
# search-domain configs, the same general class of "curl works, Python
# doesn't" issue TROUBLESHOOTING.md already documents for the Anthropic
# leg) that lookup can hang well past whatever timeout= says, and httpx
# has no way to enforce a limit on a syscall it doesn't control. A tap
# on an ordinary word sitting on "Looking it up..." for the full 15s
# frontend abort (see useTapWord.ts's FETCH_TIMEOUT_MS) with the backend
# never responding at all -- not slow, literally silent -- is exactly
# what that failure mode looks like from the outside.
#
# _fetch_dictionary_entry_exact wraps its real work in a dedicated
# executor and enforces this as a hard wall-clock deadline from OUTSIDE,
# the same "don't just trust the library's own timeout" principle
# applied to the Anthropic client in _get_anthropic_client() above.
# +1.0s over _DICTIONARY_TIMEOUT_S gives httpx's own timeout a full
# chance to fire normally first; this is the backstop for when it can't.
_DICTIONARY_HARD_DEADLINE_S = _DICTIONARY_TIMEOUT_S + 1.0

# Shared across every dictionary call (both fetch_dictionary_entry's
# parallel stemmed-candidate lookups and analyze_morphology's sequential
# prefix/suffix root checks) rather than a fresh executor per call --
# cheaper, and gives a natural cap on how many calls can be genuinely
# stuck at once. If a call's underlying socket call truly can't be
# interrupted, its worker thread is lost for the life of the process
# either way; capping max_workers just bounds how many can leak before
# new lookups start queuing behind them -- and a queued-but-not-yet-
# started lookup still correctly hits its deadline via
# Future.result(timeout=...) below, so a caller is never blocked longer
# than _DICTIONARY_HARD_DEADLINE_S even under full exhaustion.
_dictionary_executor = ThreadPoolExecutor(max_workers=16, thread_name_prefix="dict-lookup")

# Same idea as syllabify.py's _WORD_RE: strip surrounding punctuation so
# "hallucinate," or "(dog." look up cleanly. Unlike syllabify.py we don't
# need to reattach the punctuation afterward -- this is a lookup key, not
# something rendered back into the passage.
#
# Deliberately mirrors frontend/lib/useTapWord.ts's cleanWordText() rule
# exactly (strip everything except letters/digits/apostrophe/hyphen, even
# at the boundary) instead of a blanket \W+ strip -- a plain \W+ strip
# would eat a leading/trailing apostrophe on words like "'tis" or
# "Capulets'" (common in real book text), which the frontend's own
# cleaning already preserves. If the two ever disagree, the tap-word card
# can end up displaying a different word than the one actually looked up
# -- keep this in lockstep with cleanWordText() if either changes.
_STRIP_RE = re.compile(r"^[^\w'-]+|[^\w'-]+$", re.UNICODE)

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

    timeout/max_retries are also overridden here rather than left at the
    SDK's defaults (httpx.Timeout(timeout=10*60, connect=5.0),
    max_retries=2) -- and critically, each retry gets its OWN fresh
    timeout budget, so the unbounded worst case for one tap was really
    ~3 attempts x 10 minutes, not just 10. A flaky leg to the Anthropic
    API (see TROUBLESHOOTING.md's "Anthropic API connectivity" section)
    could then pin a FastAPI worker thread for up to ~30 minutes on a
    single word-example request, with the frontend's own 15s
    AbortController (see useTapWord.ts's FETCH_TIMEOUT_MS) doing nothing
    to stop it -- that abort only stops the browser from waiting, it
    doesn't cancel this synchronous backend call. Bounded to
    connect=2.5s (matching this file's own _DICTIONARY_TIMEOUT_S "fail
    fast into the fallback" convention) and 5.0s for every other phase,
    with max_retries=1 (one automatic retry for a transient blip,
    without multiplying the worst case back up): 2 attempts x 5.0s + a
    small jittered backoff is ~10.5s worst case, comfortably inside the
    frontend's 15s budget so the backend's own specific 502 error
    reaches the student before the browser's generic "taking too long"
    fallback would even fire.
    """
    global _anthropic_client
    if _anthropic_client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
        _anthropic_client = Anthropic(
            api_key=api_key,
            timeout=httpx.Timeout(timeout=5.0, connect=2.5),
            max_retries=1,
        )
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


def _fetch_dictionary_entry_exact_uncapped(word: str) -> dict | None:
    """The actual dictionaryapi.dev lookup -- see
    _fetch_dictionary_entry_exact (the public entry point every caller
    should use instead) for why this is split out and wrapped with a
    hard external deadline. One lookup for the exact string given -- no
    stemming. Returns
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


def _fetch_dictionary_entry_exact(word: str) -> dict | None:
    """Public entry point every caller (fetch_dictionary_entry,
    analyze_morphology) should use instead of the _uncapped version
    above. Same signature and return contract, but enforces
    _DICTIONARY_HARD_DEADLINE_S as a real wall-clock cap from OUTSIDE
    the call, in case the underlying request hangs somewhere httpx's own
    `timeout=` doesn't reach (see _DICTIONARY_HARD_DEADLINE_S's comment
    -- DNS resolution is the prime suspect). A deadline hit is treated
    exactly like any other lookup failure (returns None, same as a
    404/network/parse error), just logged first so it's distinguishable
    from an ordinary miss if this shows up in practice."""
    future = _dictionary_executor.submit(_fetch_dictionary_entry_exact_uncapped, word)
    try:
        return future.result(timeout=_DICTIONARY_HARD_DEADLINE_S)
    except FutureTimeoutError:
        future.cancel()  # no-op if already running, but frees it if it was still queued
        logger.warning(
            "Dictionary lookup for %r exceeded the %.1fs hard deadline -- httpx's own %.1fs "
            "timeout apparently didn't fire (likely a DNS/connect-level hang, not a slow "
            "response). Treating as a miss.",
            word,
            _DICTIONARY_HARD_DEADLINE_S,
            _DICTIONARY_TIMEOUT_S,
        )
        return None


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


# --- Rule-based respelling (the ONLY path -- see module docstring) ----
#
# Covers the common English IPA phonemes AND the specific symbol variants
# dictionaryapi.dev's real data actually uses (ɹ, ʉ, ɚ, ɡ, tied
# affricates like t͡ʃ), verified against live API responses for
# "hallucinate", "preview", "elephant", "happy", "adventure", and
# "important" while diagnosing the r-dropping bug that first motivated
# this table, and again against "fluency" while diagnosing the
# LLM-invented-syllable bug that moved respelling off Claude entirely.

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
#
# Third element is_vowel marks which entries are syllable NUCLEI (vowels,
# diphthongs, r-colored/syllabic vowels) vs. everything else (true
# consonants, plus glides j/w which pattern as consonants in English).
# That distinction is what makes real syllabification possible straight
# from the IPA even when dictionaryapi.dev gives us no syllable-
# separating dots at all (see respell_from_ipa) -- syllable boundaries
# fall out of where the vowel nuclei are, the same way a linguist would
# find them. ʔ (glottal stop) is neither -- it has no clean English-
# spelling equivalent and isn't syllabic, so it's dropped silently and
# never emitted as a token at all.
_IPA_REPLACEMENTS: list[tuple[str, str, bool | None]] = [
    ("eɪ", "ay", True),
    ("aɪ", "eye", True),
    ("ɔɪ", "oy", True),
    ("aʊ", "ow", True),
    ("oʊ", "oh", True),
    ("ɪər", "eer", True),
    ("ɛər", "air", True),
    ("ʊər", "oor", True),
    ("ɑːr", "ar", True),
    ("ɔːr", "or", True),
    ("ɜːr", "ur", True),
    ("ɔɹ", "or", True),
    ("ɑɹ", "ar", True),
    ("ɪɹ", "eer", True),
    ("ɛɹ", "air", True),
    ("iː", "ee", True),
    ("uː", "oo", True),
    ("ɑː", "ah", True),
    ("ɔː", "aw", True),
    ("ɜː", "ur", True),
    ("tʃ", "ch", False),
    ("dʒ", "j", False),
    ("ʃ", "sh", False),
    ("ʒ", "zh", False),
    ("θ", "th", False),
    ("ð", "th", False),
    ("ŋ", "ng", False),
    ("ɹ", "r", False),  # the symbol dictionaryapi.dev actually uses for English r, not plain "r"
    ("ʉ", "oo", True),  # fronted "u" variant seen in some entries
    ("ɚ", "er", True),  # rhotacized schwa, e.g. the end of "adventure"
    ("ɝ", "ur", True),  # stressed rhotacized vowel, e.g. "bird"
    ("ɡ", "g", False),  # IPA script-g codepoint, distinct from ASCII "g"
    ("ʔ", "", None),  # glottal stop -- no clean English-spelling equivalent, drop silently
    ("j", "y", False),
    ("ɪ", "ih", True),
    ("ʊ", "uu", True),
    ("ʌ", "uh", True),
    ("ə", "uh", True),
    ("æ", "a", True),
    ("ɛ", "eh", True),
    ("ɒ", "ah", True),
    ("ɔ", "aw", True),
    ("e", "eh", True),
    ("ɑ", "ah", True),
    ("i", "ee", True),
    ("u", "oo", True),
    ("o", "oh", True),
    ("a", "ah", True),
    ("r", "r", False),
    ("l", "l", False),
    ("w", "w", False),
    ("h", "h", False),
    ("m", "m", False),
    ("n", "n", False),
    ("p", "p", False),
    ("b", "b", False),
    ("t", "t", False),
    ("d", "d", False),
    ("k", "k", False),
    ("g", "g", False),
    ("f", "f", False),
    ("v", "v", False),
    ("s", "s", False),
    ("z", "z", False),
]


def _respell_syllable(syl: str) -> str:
    """Flat (non-syllabified) respelling of a single already-isolated
    chunk of IPA -- used for the WITH-dots path below, where
    dictionaryapi.dev already told us where the syllable breaks are, so
    there's nothing left for this to figure out on its own."""
    out = []
    i = 0
    while i < len(syl):
        matched = False
        for ipa_seq, respell, _is_vowel in _IPA_REPLACEMENTS:
            if syl.startswith(ipa_seq, i):
                out.append(respell)
                i += len(ipa_seq)
                matched = True
                break
        if not matched:
            i += 1  # unrecognized character (stray diacritic, etc.) -- skip it
    return "".join(out) if out else syl


def _tokenize_ipa(stripped: str) -> list[tuple[str, bool, bool]]:
    """Turn stress-mark-and-combining-mark-stripped IPA into a list of
    (respelled_piece, is_vowel, is_stressed) triples, longest-IPA-match-
    first (see _IPA_REPLACEMENTS). Stress marks are consumed as a
    zero-width flag carried forward onto the NEXT vowel token reached
    (stress belongs to a syllable's nucleus, and a stressed syllable can
    still start with one or more consonants -- e.g. "photograph"'s
    /ˈfoʊ.../ marks f as un-stressed and oʊ as the stressed nucleus, not
    the mark's literal position). ʔ and any unrecognized character are
    dropped entirely -- they're not emitted as tokens at all, so they
    can't wrongly split what should be one syllable into two."""
    tokens: list[tuple[str, bool, bool]] = []
    i = 0
    pending_stress = False
    while i < len(stripped):
        ch = stripped[i]
        if ch in _STRESS_MARKS:
            if ch == "ˈ":
                pending_stress = True
            i += 1
            continue
        matched = False
        for ipa_seq, respell, is_vowel in _IPA_REPLACEMENTS:
            if stripped.startswith(ipa_seq, i):
                if respell:  # skip ʔ's empty mapping -- see _IPA_REPLACEMENTS comment
                    if is_vowel:
                        tokens.append((respell, True, pending_stress))
                        pending_stress = False
                    else:
                        tokens.append((respell, False, False))
                i += len(ipa_seq)
                matched = True
                break
        if not matched:
            i += 1  # unrecognized character -- skip it, same as _respell_syllable
    return tokens


def _group_into_syllables(tokens: list[tuple[str, bool, bool]]) -> list[list[tuple[str, bool, bool]]] | None:
    """Groups phoneme tokens into syllables using the standard "maximal
    onset" approximation: a run of consonants between two vowel nuclei
    all go to the FOLLOWING syllable's onset except one, which stays
    behind as the preceding syllable's coda (so V-C-V splits as V.CV,
    one consonant moving entirely to the next syllable, while V-CC-V
    splits as VC.CV). Leading consonants before the first vowel are the
    first syllable's onset; trailing consonants after the last vowel are
    the last syllable's coda. Returns None if there's no vowel at all
    (e.g. tokenization found nothing usable) so the caller can fall back
    to a flat, unsegmented respelling rather than guessing."""
    vowel_idxs = [i for i, t in enumerate(tokens) if t[1]]
    if not vowel_idxs:
        return None
    syllables = []
    start = 0
    for k, vowel_i in enumerate(vowel_idxs):
        if k == len(vowel_idxs) - 1:
            end = len(tokens)  # last syllable soaks up all remaining coda consonants
        else:
            between = vowel_idxs[k + 1] - vowel_i - 1
            end = vowel_i + 1 + max(0, between - 1)
        syllables.append(tokens[start:end])
        start = end
    return syllables


def respell_from_ipa(ipa: str) -> str:
    """Rule-based, dictionary-grounded IPA -> friendly respelling -- see
    the module docstring for why this is now the ONLY path (never
    Claude-generated). Returns "" for empty input rather than guessing.

    When dictionaryapi.dev's IPA includes syllable-separating dots (rare
    in practice), each dot-delimited syllable is respelled and
    hyphenated using that given boundary directly. Far more often there
    are no dots at all -- in that case, real syllable boundaries are
    derived straight from the IPA's own vowel nuclei via
    _tokenize_ipa/_group_into_syllables (a standard maximal-onset
    syllabification), so hyphenation and stress placement are correct
    without needing dots. Whichever syllable carries the primary stress
    mark is capitalized; if no stress mark was present at all, the first
    syllable is (mirroring English's own tendency and giving a
    deterministic, non-arbitrary default). Only falls back to a flat,
    unsegmented lowercase string if no vowel could be identified at all
    (extremely unusual IPA/edge-case input) -- better than crashing or
    guessing syllable breaks with no signal to base them on."""
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

    # No syllable dots (the common case for this data source) -- derive
    # real syllable boundaries from the IPA's own vowel nuclei instead of
    # guessing or leaving it as one unhyphenated blob.
    tokens = _tokenize_ipa(stripped)
    syllables = _group_into_syllables(tokens)
    if syllables is None:
        # No vowel found at all -- nothing to syllabify around. Fall back
        # to the old flat behavior rather than fabricate a split.
        clean = stripped
        for mark in _STRESS_MARKS:
            clean = clean.replace(mark, "")
        return _respell_syllable(clean)

    stressed_index = 0
    for i, syl in enumerate(syllables):
        if any(t[2] for t in syl):
            stressed_index = i
            break
    parts = ["".join(t[0] for t in syl) for syl in syllables]
    parts[stressed_index] = parts[stressed_index].upper()
    return "-".join(parts)


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
# `definition` (and `example_sentence`, generated alongside it) they
# hold -- are keyed by (word, sentence) together. `respelling` lives in
# the same per-(word, sentence) cache entries for simplicity even though
# it's really only a function of the word's ipa, not the sentence -- a
# harmless bit of redundant recomputation the one time a word repeats in
# a new sentence, not a correctness issue. A repeat tap
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
    """Fast path: dictionary lookup + rule-based morphology + rule-based
    respelling. NO Claude call -- this is what makes the raw
    pronunciation (IPA + respelling), definition, morphology, and
    hear-aloud available essentially instantly for any word the
    dictionary has. Powers POST /api/word-info.

    `definition` is picked via _pick_best_definition -- a fast, rule-based
    best guess at which of the dictionary's candidate senses fits this
    sentence, not just the first one dictionaryapi.dev happens to list.
    It's still just a heuristic, though; get_word_example's background
    Claude call confirms/corrects it a beat later with real language
    understanding (see the module docstring's "Word-sense
    disambiguation" section).

    `respelling` is derived from `ipa` via respell_from_ipa() whenever the
    dictionary had one -- both pronunciation fields come straight from
    the dictionary now, no LLM involved (see the module docstring). It
    only comes back "" here in the rare case the dictionary had no ipa
    at all, in which case the frontend's get_word_example call (POST
    /api/word-example, fired in parallel at tap time) asks Claude for a
    best-effort ipa and derives respelling from THAT the same mechanical
    way, patching both in once that resolves. `example_sentence` always
    comes back "" here -- that one's Claude's job unconditionally, no
    dictionary equivalent exists for it."""
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
        "respelling": respell_from_ipa(ipa) if ipa else "",
        "definition": definition,
        "morphology": morphology,
        "example_sentence": "",
    }
    _quick_cache[cache_key] = result
    return result


# --- Slow path: the fields that genuinely need Claude ------------------

_ENRICH_TOOL = {
    "name": "word_enrich",
    "description": "A new example sentence for one word, plus best-effort ipa/definition if asked for.",
    "input_schema": {
        "type": "object",
        "properties": {
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
        "required": ["example_sentence", "definition"],
    },
}


def _generate_enrichment(word: str, sentence: str, need_ipa: bool, candidate_definitions: list[dict]) -> dict:
    """The one background Claude call per word: always a new example
    sentence and a context-checked definition, plus a best-effort ipa
    when dictionaryapi.dev didn't have one (a common partial case, not a
    rare one -- see the module docstring). Notably NOT asked for a
    respelling anymore -- that's derived mechanically from real ipa via
    respell_from_ipa() now, never invented by the model (see the module
    docstring for why: an LLM-written respelling had no dictionary
    backing it and could just be wrong, e.g. "fluency" coming back as
    "FLOO-un-nee" instead of the correct "FLOO-uhn-see").

    The definition is asked for every time now, not just when the
    dictionary had nothing -- dictionaryapi.dev usually returns several
    candidate senses for a word, and get_word_info_quick's fast
    word-overlap heuristic (_pick_best_definition) is only a rough first
    guess at which one fits this sentence. This call is what actually
    confirms or corrects that guess with real language understanding.
    See the module docstring's "Word-sense disambiguation" section."""
    known = []

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

    asks = ["a new example sentence"]
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
    # No timeout= override here -- this is the only call site that uses
    # this client, so it inherits the bounded timeout/max_retries set
    # once in _get_anthropic_client() above. If a second call site is
    # ever added, decide explicitly whether it should share that budget
    # rather than silently inheriting this comment's assumption.
    #
    # Logged (not just left to main.py's catch-all 502 handler) so a
    # timeout vs. a connection error vs. an API-level error are
    # distinguishable in dev.sh's [backend] output -- see
    # TROUBLESHOOTING.md's "Anthropic API connectivity" section, which
    # has an open question about *why* connections intermittently fail;
    # this doesn't answer that, but it stops it from being a silent
    # multi-minute hang with no diagnostic trail. Order matters:
    # APITimeoutError is a SUBCLASS of APIConnectionError, so it must be
    # caught first or it silently falls into the more generic branch.
    try:
        response = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=512,
            tools=[_ENRICH_TOOL],
            tool_choice={"type": "tool", "name": "word_enrich"},
            messages=[{"role": "user", "content": prompt}],
        )
    except APITimeoutError as exc:
        logger.warning("Anthropic call timed out for %r: %s", word, exc)
        raise
    except APIConnectionError as exc:
        # exc.__cause__ is where the real underlying httpx/ssl error
        # shows up -- e.g. exactly what TROUBLESHOOTING.md's suspected
        # TLS-inspecting-proxy theory would need to confirm or rule out.
        logger.warning("Anthropic connection error for %r: %s (cause=%r)", word, exc, exc.__cause__)
        raise
    except APIStatusError as exc:
        logger.warning("Anthropic API error for %r: status=%s body=%s", word, exc.status_code, exc.message)
        raise
    tool_use = next(b for b in response.content if b.type == "tool_use")
    return tool_use.input


def get_word_example(word: str, sentence: str) -> dict:
    """Slow path: the fields that genuinely need Claude. Fetched by the
    frontend in parallel with get_word_info_quick (see useTapWord.ts),
    and merged into the card once it resolves -- raw pronunciation
    (ipa + respelling)/definition/morphology/hear-aloud are already
    showable by the time this lands in the common case, so usually only
    the example sentence (all of stage 5) is waiting on it. Powers POST
    /api/word-example.

    Always returns {"respelling", "example_sentence", "definition"} --
    `definition` is Claude's context-checked pick/correction of
    get_word_info_quick's fast word-overlap guess (see the module
    docstring's "Word-sense disambiguation" section), not just a
    fallback for words the dictionary had nothing for, so the frontend's
    existing merge-on-resolve (see useTapWord.ts's fetchExampleOnly)
    already overwrites whatever the quick heuristic guessed with the
    confirmed one once this resolves -- no frontend change needed.
    `respelling` is ALWAYS included too (even though it usually hasn't
    changed since the quick fetch) because the frontend's merge is a
    plain object spread -- omitting the key here would be fine, but
    including it defensively means this function's output is self-
    contained and correct on its own, not dependent on the caller never
    having called it without a prior quick fetch. In the common partial
    case (dictionary had a definition but no phonetics, e.g.
    "hallucinate" itself) also returns "ipa" -- and backfills both
    _quick_cache (this exact word+sentence) and _dictionary_cache (this
    word, every sentence) with the invented ipa, so neither this
    function nor a fresh dictionary lookup has to run again for the same
    gap. `definition`/`respelling`/`example_sentence` are cached per
    (word, sentence) -- see _quick_cache's comment -- since which sense
    fits, and the example illustrating it, are exactly the things that
    should change if the same word shows up again in a different
    sentence."""
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

    data = _generate_enrichment(cleaned, sentence, need_ipa, candidates)

    # Mechanically derived, never Claude-written -- see the module
    # docstring and _generate_enrichment's docstring for why. When the
    # dictionary already had an ipa, quick["respelling"] was already
    # computed from it by get_word_info_quick and needs no rework here;
    # only the rare need_ipa case (Claude just invented an ipa above)
    # requires deriving a fresh respelling from that new ipa.
    respelling = quick["respelling"] if not need_ipa else respell_from_ipa(data.get("ipa") or "")
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
        updated["respelling"] = respelling  # quick's own respelling was "" (no ipa yet) -- backfill it too
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


# --- Sentence simplification (teacher-configured grade level) ---------
#
# Powers POST /api/simplify-sentence -- the "Simplify sentence" button on
# the tap-word card. Deliberately independent of the pronunciation/
# definition/morphology/hear-aloud/example stage cycle above: it acts on
# the whole SENTENCE the tapped word came from, not the word itself, and
# is available the instant the card opens regardless of which stage the
# student is on (see WordInfoPopover.tsx). grade_level comes from a
# teacher-configured setting baked into the shareable class link (see
# frontend/app/teacher/page.tsx) -- not from anything a student can set
# themselves, since letting every student silently read a different
# "simplified" version of the same passage undermines the point of the
# reading practice.
_SIMPLIFY_CACHE: dict[tuple[str, int], dict] = {}


def _assess_and_simplify_tool(grade_level: int) -> dict:
    """Tool schema is built per-call (not a module-level constant like
    _ENRICH_TOOL) since its description embeds grade_level -- cheap, and
    keeps the calibration instruction right next to the field it
    constrains instead of only living in the prompt text."""
    return {
        "name": "assess_and_simplify",
        "description": (
            "Judge whether a sentence already reads as plain, literal language at or below "
            "a target grade level, and if it doesn't, rewrite the WHOLE sentence (not just "
            "individual words) into one that does."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "needs_simplification": {
                    "type": "boolean",
                    "description": (
                        "False if the sentence is ALREADY literal (no figurative language, "
                        "archaic or unusual wording, or unusually complex structure) and would "
                        f"already be easy for a grade {grade_level} reader as written -- true "
                        "otherwise. Judge honestly: most short, plain, modern-English sentences "
                        "should come back false, not every sentence needs rewriting."
                    ),
                },
                "simplified": {
                    "type": "string",
                    "description": (
                        "The WHOLE sentence rewritten in simpler language a grade "
                        f"{grade_level} student would find easy to read, keeping the same "
                        "meaning and not inventing new details. Required (non-empty) when "
                        "needs_simplification is true; leave as an empty string when false."
                    ),
                },
            },
            "required": ["needs_simplification", "simplified"],
        },
    }


def simplify_sentence(sentence: str, grade_level: int) -> dict:
    """Assesses whether `sentence` already reads as plain, literal language
    at grade level, and if not, rewrites the WHOLE sentence (not
    word-by-word or chunk-by-chunk -- a single coherent rewrite) to
    `grade_level` via one Claude tool-use call. Deliberately does the
    assessment and the rewrite together in one round trip rather than two
    separate calls -- functionally the same "judge first, then simplify
    only if needed" behavior, just without paying for a second Anthropic
    call to get it.

    Returns {"needs_simplification": bool, "simplified": str} --
    `simplified` is "" whenever needs_simplification is false, which
    WordInfoPopover.tsx renders as "No simplified sentence available."
    instead of a comparison, rather than showing a pointless rewrite of a
    sentence that didn't need one. Cached by (sentence, grade_level) for
    the process lifetime -- same reasoning as _quick_cache/_example_cache:
    a student re-opening the same sentence's card, or a classmate on the
    same shared teacher link hitting the same sentence, shouldn't pay for
    a second round trip.

    grade_level is currently hardcoded to 9 below, ignoring whatever the
    teacher-configured link actually sent -- an explicit, temporary
    simplification while this feature's core judgment (assess-then-
    simplify, whole sentence not chunks) gets dialed in; the real
    grade_level is left as this function's parameter (not removed) so
    main.py's route and the frontend's plumbing don't need to change
    again once it's wired back in."""
    grade_level = 9  # TODO: use the real (clamped) grade_level once the prompt above is solid
    cache_key = (sentence, grade_level)
    cached = _SIMPLIFY_CACHE.get(cache_key)
    if cached is not None:
        return cached

    client = _get_anthropic_client()
    prompt = (
        f'Sentence: "{sentence}"\n\n'
        f"First judge: is this sentence already plain, literal, modern English that would "
        f"already be easy for a grade {grade_level} reader exactly as written? If yes, "
        "needs_simplification is false and simplified can be left empty. If no -- it uses "
        "figurative language, archaic or unusual wording, or an unusually complex structure "
        "-- set needs_simplification to true and rewrite the WHOLE sentence in simpler "
        "language, keeping the same meaning. Call the assess_and_simplify tool."
    )
    # Same bounded client (timeout/max_retries set once in
    # _get_anthropic_client()) and the same logged-then-re-raised
    # exception handling as _generate_enrichment above, so a flaky
    # connection fails fast into main.py's CORS-safe 502 handler instead
    # of hanging silently.
    try:
        response = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=384,
            tools=[_assess_and_simplify_tool(grade_level)],
            tool_choice={"type": "tool", "name": "assess_and_simplify"},
            messages=[{"role": "user", "content": prompt}],
        )
    except APITimeoutError as exc:
        logger.warning("Anthropic call timed out simplifying a sentence: %s", exc)
        raise
    except APIConnectionError as exc:
        logger.warning("Anthropic connection error simplifying a sentence: %s (cause=%r)", exc, exc.__cause__)
        raise
    except APIStatusError as exc:
        logger.warning("Anthropic API error simplifying a sentence: status=%s body=%s", exc.status_code, exc.message)
        raise

    tool_use = next(b for b in response.content if b.type == "tool_use")
    needs_simplification = bool(tool_use.input.get("needs_simplification"))
    simplified = (tool_use.input.get("simplified") or "").strip() if needs_simplification else ""

    result = {"needs_simplification": needs_simplification, "simplified": simplified}
    _SIMPLIFY_CACHE[cache_key] = result
    return result
