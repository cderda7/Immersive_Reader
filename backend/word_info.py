"""Tap-word lookup pipeline.

Powers POST /api/word-info -- the backend half of the reading pane's
tap-to-define feature (tap a word, cycle through pronunciation ->
definition -> morphology (if useful) -> hear-aloud -> AI example
sentence). See frontend/lib/useTapWord.ts for the tap-cycling state
machine this feeds.

Split the same way the rest of this backend splits "fact" from
"generated content": pronunciation and definition come from a real
dictionary (dictionaryapi.dev, free, no key) so they're accurate: not
hallucinated. Claude is only asked for the genuinely generative/judgment
parts -- a friendly respelling grounded in the real IPA, whether a
morphology breakdown is worth showing at all for this word, and one
grade-appropriate example sentence -- combined into a SINGLE call rather
than three separate ones, to keep latency down.
"""

import os
import re

import httpx
from anthropic import Anthropic

DICTIONARY_API_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/{word}"

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
    process-start order) -- only actually calling generate_word_bundle
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


def fetch_dictionary_entry(word: str) -> dict | None:
    """Look up `word` against the free dictionaryapi.dev API. Returns
    {"ipa": str | None, "definition": str | None} on success, or None on
    a 404 (word not found) or any network/parse failure -- callers fall
    back to asking Claude for a best-effort version instead of failing
    the whole request over one missing dictionary entry."""
    try:
        resp = httpx.get(DICTIONARY_API_URL.format(word=word), timeout=5.0)
        if resp.status_code != 200:
            return None
        entries = resp.json()
        if not entries:
            return None
    except (httpx.HTTPError, ValueError):
        return None

    ipa = None
    definition = None
    for entry in entries:
        if ipa is None:
            for phonetic in entry.get("phonetics", []):
                text = phonetic.get("text")
                if text:
                    ipa = text
                    break
            if ipa is None and entry.get("phonetic"):
                ipa = entry["phonetic"]
        if definition is None:
            for meaning in entry.get("meanings", []):
                for d in meaning.get("definitions", []):
                    if d.get("definition"):
                        definition = d["definition"]
                        break
                if definition is not None:
                    break
        if ipa is not None and definition is not None:
            break

    if ipa is None and definition is None:
        return None
    return {"ipa": ipa, "definition": definition}


_BUNDLE_TOOL = {
    "name": "word_bundle",
    "description": "Structured tap-to-define content for one word.",
    "input_schema": {
        "type": "object",
        "properties": {
            "ipa": {
                "type": "string",
                "description": (
                    "IPA pronunciation. Only fill this in if no real dictionary "
                    "IPA was provided in the prompt -- otherwise repeat the given "
                    "one back exactly."
                ),
            },
            "definition": {
                "type": "string",
                "description": (
                    "A grade 7-12-appropriate definition. Only write a new one if "
                    "no dictionary definition was provided in the prompt -- "
                    "otherwise repeat the given one back exactly."
                ),
            },
            "respelling": {
                "type": "string",
                "description": (
                    "Friendly syllable-stress respelling grounded in the given IPA, "
                    "e.g. 'huh-LOO-sih-nayt' for the IPA of \"hallucinate\" "
                    "-- capitalize the stressed syllable, hyphenate the rest."
                ),
            },
            "morphology_useful": {
                "type": "boolean",
                "description": (
                    "True only if this word has a transparent prefix/root/suffix "
                    "breakdown that would genuinely help a struggling reader (e.g. "
                    "'preview' -> pre + view). False for words whose root isn't a "
                    "recognizable standalone piece to a student (e.g. 'hallucinate')."
                ),
            },
            "morphology_parts": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Only if morphology_useful: the word split into its parts, e.g. ['pre', 'view']. Omit/empty otherwise.",
            },
            "morphology_note": {
                "type": "string",
                "description": "Only if morphology_useful: one short plain-English line, e.g. 'pre- (before) + view'. Omit otherwise.",
            },
            "example_sentence": {
                "type": "string",
                "description": (
                    "One natural, grade 7-12-appropriate sentence using the word in "
                    "a similar sense to the context sentence provided -- not the "
                    "context sentence itself, a new one."
                ),
            },
        },
        "required": ["respelling", "morphology_useful", "example_sentence"],
    },
}


def generate_word_bundle(
    word: str, ipa: str | None, definition: str | None, sentence: str
) -> dict:
    """One Anthropic call for everything that's genuinely generative:
    the friendly respelling, whether morphology is worth showing (plus
    the breakdown if so), and an example sentence. Also backstops
    ipa/definition when the dictionary lookup came back empty, so the
    endpoint degrades gracefully instead of failing outright on a word
    dictionaryapi.dev doesn't have (slang, proper nouns, etc.)."""
    known = []
    if ipa:
        known.append(f'Real dictionary IPA: "{ipa}" -- use this exactly, do not invent a different one.')
    if definition:
        known.append(f'Real dictionary definition: "{definition}" -- use this exactly, do not rewrite it.')
    missing_note = ""
    if not ipa or not definition:
        missing_note = (
            "\nNo dictionary entry was found for this word, so also provide your "
            "own best-effort ipa and/or definition fields."
        )

    prompt = (
        f'Word: "{word}"\n'
        f'Sentence it was tapped from: "{sentence}"\n\n'
        + "\n".join(known)
        + missing_note
        + "\n\nThis is for a grade 7-12 student using a reading-fluency tool. "
        "Call the word_bundle tool with the structured content."
    )

    client = _get_anthropic_client()
    response = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=1024,
        tools=[_BUNDLE_TOOL],
        tool_choice={"type": "tool", "name": "word_bundle"},
        messages=[{"role": "user", "content": prompt}],
    )

    tool_use = next(b for b in response.content if b.type == "tool_use")
    data = tool_use.input

    morphology = None
    if data.get("morphology_useful") and data.get("morphology_parts"):
        morphology = {
            "parts": data["morphology_parts"],
            "note": data.get("morphology_note", ""),
        }

    return {
        "ipa": ipa or data.get("ipa", ""),
        "definition": definition or data.get("definition", ""),
        "respelling": data.get("respelling", ""),
        "morphology": morphology,
        "example_sentence": data.get("example_sentence", ""),
    }


def get_word_info(word: str, sentence: str) -> dict:
    """Orchestrates the full tap-to-define lookup for one word: clean ->
    dictionary lookup -> Claude bundle -> combine into the shape the
    frontend's WordInfo type expects."""
    cleaned = clean_word(word)
    if not cleaned:
        cleaned = word.strip().lower()

    dictionary_entry = fetch_dictionary_entry(cleaned) or {}
    bundle = generate_word_bundle(
        cleaned, dictionary_entry.get("ipa"), dictionary_entry.get("definition"), sentence
    )

    return {
        "word": cleaned,
        "ipa": bundle["ipa"],
        "respelling": bundle["respelling"],
        "definition": bundle["definition"],
        "morphology": bundle["morphology"],
        "example_sentence": bundle["example_sentence"],
    }
