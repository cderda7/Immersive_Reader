"""Offline book-ingestion CLI.

Turns a raw book text file (e.g. a Project Gutenberg download) into the
static, per-chapter syllable data the frontend's Library picker reads
directly (frontend/public/library/...) -- no live backend call needed to
read a chapter once it's been ingested. Run this once per new book; it's
not part of the live API surface (main.py never imports this module).

Usage (run from inside backend/, so the relative --output-dir default and
the `from syllabify import ...` import both resolve):

    python ingest_book.py \\
        --slug moby-dick \\
        --title "Moby Dick; or, The Whale" \\
        --author "Herman Melville" \\
        --input ../library/moby_dick.txt
        # no --chapter-marker needed -- "^CHAPTER \\d+\\." is the default,
        # since plain numbered chapters are the common case for a novel.

    python ingest_book.py \\
        --slug romeo-and-juliet \\
        --title "Romeo and Juliet" \\
        --author "William Shakespeare" \\
        --input ../library/romeo_and_juliet.txt \\
        --chapter-marker "^SCENE " \\
        --act-marker "^ACT "
        # a play needs its own --chapter-marker (scenes, not chapters) --
        # this is the "~5 minutes of configuration" Carson's bar allows
        # for a book that doesn't fit the default shape.

Pipeline, per book:
  1. Slice the real body out using Project Gutenberg's standard
     "*** START OF ... ***" / "*** END OF ... ***" markers.
  2. Normalize punctuation via syllabify.py's _normalize_punctuation
     (curly quotes/dashes -> straight) -- the same normalization the
     live /api/syllabify path applies, reused here (not
     re-implemented) so ingested chapters and freshly-pasted text are
     processed identically.
  3. Find every line matching --chapter-marker. Real books commonly
     also list their chapter/scene titles in a table of contents
     before the actual body (confirmed for both books shipped today:
     Moby Dick repeats all 135 "CHAPTER n." headings in a contents
     list before the real Chapter 1; Romeo & Juliet does the same with
     its 5 "ACT n" headings) -- those listing entries sit right next
     to each other, while real chapter/scene bodies don't. See
     _find_body_start: it looks for the first big jump in distance
     between consecutive matches and treats everything before that
     jump as front-matter, not a chapter.
  4. Split the remaining text at each surviving marker into chunks.
  5. Run each chunk through syllabify.syllabify() -- the exact
     function the live /api/syllabify route uses.
  6. Print a sanity report (chapter count, word count per chapter with
     outliers flagged, and a count of any token syllabify's _WORD_RE
     failed to fully parse) -- meant to replace "read the whole book"
     with "read one short report" before trusting the output. See
     Carson's ask: a new book should take "maybe 5 minutes, but need
     no human review" of the actual content.
  7. Write frontend/public/library/<slug>/manifest.json (chapter list)
     and one frontend/public/library/<slug>/<chapter-id>.json per
     chapter (that chapter's flat Syllable[] -- same shape
     /api/syllabify already returns), then add/replace this book's
     entry in frontend/public/library/index.json.
"""

import argparse
import json
import re
import statistics
import sys
from pathlib import Path

from syllabify import syllabify, _normalize_punctuation, _WORD_RE

GUTENBERG_START_RE = re.compile(r"\*\*\* START OF .*? \*\*\*", re.IGNORECASE)
GUTENBERG_END_RE = re.compile(r"\*\*\* END OF .*? \*\*\*", re.IGNORECASE)

# A hard floor for "this gap is too small to be a real chapter body,
# it's a table-of-contents listing" -- combined with a threshold
# relative to the book's own typical chapter length (see
# _find_body_start), so this works for both a 1600-word-per-chapter
# novel and a book with much shorter chapters, not just one hand-tuned
# scale.
_TOC_GAP_FLOOR_CHARS = 300
_TOC_GAP_RELATIVE_FRACTION = 0.25

# Flag a chapter's word count as an outlier if it's this many times
# smaller/larger than the book's median chapter -- just a "worth a
# look" signal in the report, not a hard failure.
_OUTLIER_RATIO = 4.0


def _slice_gutenberg_body(raw: str) -> str:
    """Strip Project Gutenberg's license/header/footer boilerplate,
    keeping only the real text between its standard START/END markers."""
    start_match = GUTENBERG_START_RE.search(raw)
    end_match = GUTENBERG_END_RE.search(raw)
    if not start_match or not end_match:
        print(
            "WARNING: couldn't find both Gutenberg START/END markers -- using the "
            "whole file as the body. If this isn't a Gutenberg text that's expected; "
            "otherwise double-check the boilerplate got stripped correctly.",
            file=sys.stderr,
        )
    start = raw.index("\n", start_match.end()) + 1 if start_match else 0
    end = end_match.start() if end_match else len(raw)
    return raw[start:end]


def _find_body_start(matches: list[re.Match], skip_toc: int | None) -> int:
    """Return the index into `matches` where the REAL chapter/scene body
    begins, skipping a leading table-of-contents-style cluster of
    matches if one exists. --skip-toc overrides this entirely, for the
    rare book where the heuristic guesses wrong.

    The "is this a ToC entry" threshold is relative to the book's OWN
    typical chapter length, not a fixed number -- a contents listing can
    repeat at most one entry per real chapter (never more), so the back
    half of all gaps is guaranteed to be real chapter-to-chapter gaps
    even in the worst case (a listing as long as the real body), which
    makes it a safe reference point regardless of whether this book's
    chapters run long (a novel) or short."""
    n = len(matches)
    if skip_toc is not None:
        return skip_toc
    if n < 4:
        return 0

    gaps = [matches[i + 1].start() - matches[i].start() for i in range(n - 1)]
    reference_gaps = gaps[n // 2 :] or gaps
    reference = statistics.median(reference_gaps)
    toc_like_threshold = max(_TOC_GAP_FLOOR_CHARS, reference * _TOC_GAP_RELATIVE_FRACTION)

    if gaps[0] >= toc_like_threshold:
        return 0  # no leading cluster -- the very first gap already looks like a real chapter
    for i, gap in enumerate(gaps):
        if gap >= toc_like_threshold:
            return i + 1
    return 0


def _chunk_book(text: str, chapter_marker: str, act_marker: str | None, skip_toc: int | None) -> list[dict]:
    chapter_re = re.compile(chapter_marker, re.MULTILINE)
    matches = list(chapter_re.finditer(text))
    if not matches:
        raise SystemExit(f"No matches for --chapter-marker {chapter_marker!r} -- check the pattern against the input file.")

    body_start_idx = _find_body_start(matches, skip_toc)
    if body_start_idx:
        print(f"Skipped {body_start_idx} table-of-contents-style match(es) before the real body starts.")
    matches = matches[body_start_idx:]

    # Deliberately NOT filtered to positions at/after the real body start
    # the way `matches` is above: a real act header commonly sits
    # immediately before its first real scene (see the "preceding_acts"
    # lookup below), which can itself be earlier than matches[0] once
    # ToC-listing scene/chapter entries get skipped. Any ToC-listing act
    # headers before the real body naturally lose out anyway, since
    # "nearest preceding" always prefers the real act header that's
    # closer (later in the text) to each scene over an earlier listing.
    act_matches: list[re.Match] = []
    if act_marker:
        act_re = re.compile(act_marker, re.MULTILINE)
        act_matches = list(act_re.finditer(text))

    chunks = []
    for i, match in enumerate(matches):
        chunk_start = match.start()
        chunk_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk_text = text[chunk_start:chunk_end].strip()
        heading = chunk_text.splitlines()[0].strip()

        preceding_acts = [a for a in act_matches if a.start() <= chunk_start]
        # The act LABEL is the act marker's whole line (e.g. "ACT II"),
        # not just the regex's own matched span (e.g. "^ACT " matches
        # only "ACT ", losing the roman numeral that follows it).
        act_label = text[preceding_acts[-1].start():].splitlines()[0].strip() if preceding_acts else None

        title = f"{act_label}, {heading}" if act_label else heading
        chunks.append({"title": title, "text": chunk_text})

    return chunks


def _count_unparsed_tokens(chunk_text: str) -> int:
    """Count tokens that don't fully parse via syllabify's _WORD_RE --
    should be ~0 after normalization; a nonzero count is a signal to
    look closer at this chunk rather than trust it blind."""
    return sum(1 for token in chunk_text.split() if not _WORD_RE.match(token))


def _update_index(library_dir: Path, slug: str, title: str, author: str, chapter_count: int) -> None:
    index_path = library_dir / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {"books": []}
    index["books"] = [b for b in index["books"] if b["slug"] != slug]
    index["books"].append({"slug": slug, "title": title, "author": author, "chapter_count": chapter_count})
    library_dir.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(index, indent=2), encoding="utf-8")


def ingest(args: argparse.Namespace) -> None:
    raw = Path(args.input).read_text(encoding="utf-8")
    body = _normalize_punctuation(_slice_gutenberg_body(raw))
    chunks = _chunk_book(body, args.chapter_marker, args.act_marker, args.skip_toc)

    word_counts = [len(c["text"].split()) for c in chunks]
    median = statistics.median(word_counts)
    print(f"\n{args.title}: {len(chunks)} chapters/scenes detected.")
    print(f"Word counts -- median {median:.0f}, min {min(word_counts)}, max {max(word_counts)}\n")

    out_dir = Path(args.output_dir) / args.slug
    out_dir.mkdir(parents=True, exist_ok=True)

    total_unparsed = 0
    manifest_chapters = []
    for i, chunk in enumerate(chunks):
        chapter_id = f"{i + 1:03d}"
        wc = word_counts[i]
        flag = ""
        if median > 0 and (wc < median / _OUTLIER_RATIO or wc > median * _OUTLIER_RATIO):
            flag = "  <-- word count is a big outlier, worth a look"
        unparsed = _count_unparsed_tokens(chunk["text"])
        total_unparsed += unparsed
        unparsed_note = f", {unparsed} unparsed token(s)" if unparsed else ""
        print(f"  [{chapter_id}] {chunk['title']} -- {wc} words{unparsed_note}{flag}")

        syllables = syllabify(chunk["text"])
        (out_dir / f"{chapter_id}.json").write_text(json.dumps(syllables), encoding="utf-8")
        manifest_chapters.append({"id": chapter_id, "title": chunk["title"], "word_count": wc})

    manifest = {"slug": args.slug, "title": args.title, "author": args.author, "chapters": manifest_chapters}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(
        f"\nTotal unparsed tokens across the book: {total_unparsed}"
        + ("  <-- worth a look before shipping" if total_unparsed else "  (clean)")
    )

    _update_index(Path(args.output_dir), args.slug, args.title, args.author, len(chunks))
    print(f"\nWrote {len(chunks)} chapter file(s) + manifest.json to {out_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest a raw book text file into static per-chapter syllable data.")
    parser.add_argument("--slug", required=True, help="URL-safe id, e.g. moby-dick")
    parser.add_argument("--title", required=True)
    parser.add_argument("--author", default="")
    parser.add_argument("--input", required=True, help="Path to the raw book text file")
    parser.add_argument(
        "--chapter-marker",
        default=r"^CHAPTER \d+\.",
        help=r"Regex (matched per-line start, MULTILINE) marking each chapter/scene. Defaults to plain numbered "
        r"chapters ('^CHAPTER \d+\.') since that's the common case for a novel -- override for anything else, "
        r"e.g. '^SCENE ' for a play.",
    )
    parser.add_argument(
        "--act-marker",
        default=None,
        help="Optional coarser regex (e.g. '^ACT ') used to prefix each chunk's title with the act/section it falls under",
    )
    parser.add_argument(
        "--skip-toc",
        type=int,
        default=None,
        help="Override how many leading --chapter-marker matches to discard as a table-of-contents listing, if the automatic detection guesses wrong",
    )
    parser.add_argument("--output-dir", default="../frontend/public/library", help="Where to write the generated library data")
    args = parser.parse_args()
    ingest(args)


if __name__ == "__main__":
    main()
