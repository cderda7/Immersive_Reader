"""Deprecated: syllabification now lives in syllabify.py.

This module previously held a stub `syllabify()` built around a singly
linked list. We moved to a flat list of syllable dicts tagged with
(paragraph_idx, word_idx, syllable_idx) instead -- simpler to serialize
to JSON, and advancing the reading position is just `index + 1` rather
than a linked-list walk. Kept as a thin re-export so nothing importing
`from read import syllabify` breaks; new code should import from
syllabify.py directly.
"""

from syllabify import syllabify  # noqa: F401
