"""Content-authoring helper: flag words worth a human eyeball before
shipping a demo passage, per the "AI proposes, human approves" pattern
used elsewhere in this project (see the question-review screen on Day 2).

Usage:
    python3 audit_syllables.py path/to/passage.txt
    echo "some passage text" | python3 audit_syllables.py

Flags any word that comes back as a single unbroken syllable despite
being long enough (>= FLAG_MIN_LENGTH letters) to plausibly have more
than one -- these are exactly the blind spots documented in syllabify.py
(SYLLABLE_OVERRIDES). Not every flagged word is actually wrong; this
just narrows a human review pass to a short list instead of eyeballing
the whole passage by hand. Run this against your real demo passages
(not just the two provided here) before Tuesday's demo.
"""

import re
import sys
from collections import defaultdict

from syllabify import syllabify

FLAG_MIN_LENGTH = 4


def find_suspect_words(passage: str) -> list[str]:
    result = syllabify(passage)

    words: dict[tuple[int, int], list[str]] = defaultdict(list)
    for s in result:
        words[(s["paragraph_idx"], s["word_idx"])].append(s["text"])

    suspects: list[str] = []
    seen: set[str] = set()
    for parts in words.values():
        if len(parts) != 1:
            continue
        core = re.sub(r"\W", "", parts[0])
        if len(core) >= FLAG_MIN_LENGTH and core.lower() not in seen:
            seen.add(core.lower())
            suspects.append(core)
    return suspects


def main() -> None:
    if len(sys.argv) > 1:
        with open(sys.argv[1]) as f:
            passage = f.read()
    else:
        passage = sys.stdin.read()

    suspects = find_suspect_words(passage)
    if not suspects:
        print(
            f"No suspect words found (nothing came back unbroken at >= "
            f"{FLAG_MIN_LENGTH} letters)."
        )
        return

    print(f"{len(suspects)} word(s) worth a manual check (unbroken, >= {FLAG_MIN_LENGTH} letters):")
    for w in sorted(suspects, key=str.lower):
        print(f"  - {w}")
    print(
        "\nIf any of these are actually multisyllabic, add a correction to "
        "SYLLABLE_OVERRIDES in syllabify.py."
    )


if __name__ == "__main__":
    main()
