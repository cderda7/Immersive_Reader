"use client";

import { useEffect, useState } from "react";

interface LibraryBook {
  slug: string;
  title: string;
  author: string;
  chapter_count: number;
}

interface LibraryChapter {
  id: string;
  title: string;
  word_count: number;
}

interface LibraryPickerProps {
  onLoadChapter: (bookSlug: string, chapterId: string) => void;
  isLoading: boolean;
  loadError: string | null;
}

// Curated-library reading path: fetches the static index/manifest/
// chapter JSON backend/ingest_book.py generates (frontend/public/
// library/...) and lets the student pick a book, then a chapter/scene,
// which loads straight from that static file (see useReadingState.ts's
// loadChapter) -- no live backend call needed to read a chapter. This
// is the PRIMARY way students get content; the free-text PassageLoader
// stays as a secondary dev/demo tool for the live /api/syllabify path.
export function LibraryPicker({ onLoadChapter, isLoading, loadError }: LibraryPickerProps) {
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [indexError, setIndexError] = useState<string | null>(null);

  const [selectedSlug, setSelectedSlug] = useState("");
  const [chapters, setChapters] = useState<LibraryChapter[]>([]);
  const [isManifestLoading, setIsManifestLoading] = useState(false);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState("");

  // Book list, fetched once on mount.
  useEffect(() => {
    let cancelled = false;
    fetch("/library/index.json")
      .then((res) => {
        if (!res.ok) throw new Error(`index.json returned ${res.status}`);
        return res.json();
      })
      .then((data: { books?: LibraryBook[] }) => {
        if (!cancelled) setBooks(data.books ?? []);
      })
      .catch((err) => {
        if (!cancelled) {
          setIndexError(err instanceof Error ? err.message : "Couldn't load the library index.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // That book's chapter/scene list, re-fetched whenever the book selection changes.
  useEffect(() => {
    if (!selectedSlug) {
      setChapters([]);
      setSelectedChapterId("");
      return;
    }
    let cancelled = false;
    setIsManifestLoading(true);
    setManifestError(null);
    fetch(`/library/${selectedSlug}/manifest.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`manifest.json returned ${res.status}`);
        return res.json();
      })
      .then((data: { chapters?: LibraryChapter[] }) => {
        if (cancelled) return;
        const list = data.chapters ?? [];
        setChapters(list);
        setSelectedChapterId(list[0]?.id ?? "");
      })
      .catch((err) => {
        if (!cancelled) {
          setManifestError(err instanceof Error ? err.message : "Couldn't load that book's chapter list.");
        }
      })
      .finally(() => {
        if (!cancelled) setIsManifestLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSlug]);

  // Auto-load: fires whenever the selected book+chapter pair changes --
  // either a direct chapter pick, or the default first chapter that lands
  // automatically once a newly-selected book's manifest comes in. No
  // separate "Load chapter" step for the student to remember; picking is
  // loading. Re-selecting the same option is a no-op since neither value
  // actually changes, so this can't fire a redundant reload on its own.
  useEffect(() => {
    if (selectedSlug && selectedChapterId) {
      onLoadChapter(selectedSlug, selectedChapterId);
    }
  }, [selectedSlug, selectedChapterId, onLoadChapter]);

  const errorToShow = indexError || manifestError || loadError;

  return (
    <div className="library-picker">
      <div className="library-picker-row">
        <span className="control-label">Library</span>
        <select
          className="library-picker-select"
          aria-label="Choose a book"
          value={selectedSlug}
          onChange={(e) => setSelectedSlug(e.target.value)}
        >
          <option value="">Choose a book…</option>
          {books.map((book) => (
            <option key={book.slug} value={book.slug}>
              {book.title}
              {book.author ? ` — ${book.author}` : ""}
            </option>
          ))}
        </select>
        <select
          className="library-picker-select"
          aria-label="Choose a chapter"
          value={selectedChapterId}
          disabled={!selectedSlug || isManifestLoading || isLoading || chapters.length === 0}
          onChange={(e) => setSelectedChapterId(e.target.value)}
        >
          {chapters.map((chapter) => (
            <option key={chapter.id} value={chapter.id}>
              {chapter.title}
            </option>
          ))}
        </select>
        {isLoading && <span className="library-picker-status">Loading…</span>}
      </div>
      {errorToShow && <span className="passage-loader-error">{errorToShow}</span>}
    </div>
  );
}
