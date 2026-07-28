"use client";

import { useState } from "react";

interface PassageLoaderProps {
  onLoad: (passageText: string) => void;
  isLoading: boolean;
  loadError: string | null;
}

// Demonstrates the "syllable segmentation is a real, live library call"
// decision: paste arbitrary text, hit the FastAPI /api/syllabify route,
// and the reading pane above swaps to it. The core demo passages don't
// depend on this -- they ship as static data -- but this is the
// scalability proof point if handed an unfamiliar passage live.
export function PassageLoader({ onLoad, isLoading, loadError }: PassageLoaderProps) {
  const [draft, setDraft] = useState("");

  return (
    <details className="passage-loader">
      <summary>Test live on your own text</summary>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Paste a passage (blank line = new paragraph)…"
        rows={4}
      />
      <div className="passage-loader-row">
        <button
          className="return-btn"
          disabled={isLoading || !draft.trim()}
          onClick={() => onLoad(draft)}
        >
          {isLoading ? "Syllabifying…" : "Load into reading pane"}
        </button>
        {loadError && <span className="passage-loader-error">{loadError}</span>}
      </div>
    </details>
  );
}
