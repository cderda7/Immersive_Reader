"use client";

import { useEffect, useState } from "react";

interface LibraryBook {
  slug: string;
  title: string;
  author: string;
  chapter_count: number;
}

// This app's whole stated audience (see README) -- deliberately a fixed
// dropdown, not a free-typed number, so a teacher can't accidentally
// generate a link with a grade level outside what the reading UI was
// ever designed for.
const GRADE_OPTIONS = [7, 8, 9, 10, 11, 12];

// Minimal on purpose -- exactly the two decisions a teacher actually
// needs to make (which book, what grade level), then a link to hand to
// students. No accounts, no auth, no server-side state: the link IS the
// configuration, the same "no database" architecture as the rest of
// this backend (see backend/main.py's module docstring), just encoded
// in a URL instead of a request body.
export default function TeacherPage() {
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [indexError, setIndexError] = useState<string | null>(null);

  const [selectedSlug, setSelectedSlug] = useState("");
  const [defaultChapterId, setDefaultChapterId] = useState<string | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);

  const [gradeLevel, setGradeLevel] = useState(9);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Book list, fetched once on mount -- same static manifest LibraryPicker
  // reads, so a book only ever needs to exist in one place.
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
        if (!cancelled) setIndexError(err instanceof Error ? err.message : "Couldn't load the library.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // First chapter/scene of whichever book is selected -- mirrors
  // LibraryPicker's own "picking a book auto-selects its first chapter"
  // default, so a teacher only ever makes ONE content decision (which
  // book), not two. Any previously-generated link is invalidated the
  // moment the book selection changes, so it's never possible to copy a
  // stale link that doesn't match what's shown on screen.
  useEffect(() => {
    setLink(null);
    if (!selectedSlug) {
      setDefaultChapterId(null);
      return;
    }
    let cancelled = false;
    setManifestError(null);
    fetch(`/library/${selectedSlug}/manifest.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`manifest.json returned ${res.status}`);
        return res.json();
      })
      .then((data: { chapters?: { id: string }[] }) => {
        if (cancelled) return;
        setDefaultChapterId(data.chapters?.[0]?.id ?? null);
      })
      .catch((err) => {
        if (!cancelled) {
          setManifestError(err instanceof Error ? err.message : "Couldn't load that book's chapters.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSlug]);

  function generateLink() {
    if (!selectedSlug || !defaultChapterId) return;
    const url = new URL(window.location.origin);
    url.searchParams.set("book", selectedSlug);
    url.searchParams.set("chapter", defaultChapterId);
    url.searchParams.set("grade", String(gradeLevel));
    setLink(url.toString());
    setCopied(false);
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail (permissions, non-secure context) -- the
      // link is already visible and selectable in the input either way,
      // so this degrades gracefully rather than needing its own error UI.
    }
  }

  return (
    <main className="teacher-page">
      <div className="teacher-card">
        <h1 className="teacher-card__title">Set up a class link</h1>
        <p className="teacher-card__subtitle">
          Choose a book and a grade level, then share the link below with your students.
        </p>

        <label className="teacher-field">
          <span className="control-label">Book</span>
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
        </label>

        <label className="teacher-field">
          <span className="control-label">Grade level</span>
          <select
            className="library-picker-select"
            aria-label="Choose a grade level"
            value={gradeLevel}
            onChange={(e) => {
              setGradeLevel(Number(e.target.value));
              setLink(null);
            }}
          >
            {GRADE_OPTIONS.map((grade) => (
              <option key={grade} value={grade}>
                Grade {grade}
              </option>
            ))}
          </select>
        </label>

        {(indexError || manifestError) && (
          <span className="passage-loader-error">{indexError || manifestError}</span>
        )}

        <button
          type="button"
          className="teacher-generate-btn"
          disabled={!selectedSlug || !defaultChapterId}
          onClick={generateLink}
        >
          Generate student link
        </button>

        {link && (
          <div className="teacher-link-row">
            <input
              className="teacher-link-input"
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Student link"
            />
            <button type="button" className="teacher-copy-btn" onClick={copyLink}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
