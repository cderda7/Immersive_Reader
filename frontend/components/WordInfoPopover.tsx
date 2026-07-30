"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ActiveWord, TapWordStage } from "@/lib/useTapWord";
import type { WordInfo } from "@/lib/types";

interface WordInfoPopoverProps {
  activeWord: ActiveWord;
  stage: TapWordStage;
  wordInfo: WordInfo | null;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
  onReplayAudio: () => void;
}

const GAP_PX = 10;
const VIEWPORT_PADDING = 12;

// Looks up the tapped word's own span, plus every word span sharing its
// sentence (for the "clear the whole sentence, not just this word" rule).
// DOM order matches reading order, so the sentence's topmost/bottommost
// points are just the first/last elements in that NodeList -- no need to
// sort by word_idx.
function querySentenceWords(paragraphIdx: number, sentenceIdx: number): NodeListOf<Element> {
  return document.querySelectorAll(
    `[data-paragraph-idx="${paragraphIdx}"][data-sentence-idx="${sentenceIdx}"]`
  );
}

function queryWord(paragraphIdx: number, wordIdx: number): Element | null {
  return document.querySelector(`[data-paragraph-idx="${paragraphIdx}"][data-word-idx="${wordIdx}"]`);
}

export function WordInfoPopover({
  activeWord,
  stage,
  wordInfo,
  isLoading,
  error,
  onClose,
  onReplayAudio,
}: WordInfoPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{ top: number; left: number } | null>(null);

  // Re-measure and reposition whenever the tapped word or the visible
  // stage changes -- content height varies by stage (a definition is
  // taller than "hear it aloud"), so the box has to stay flush above the
  // sentence rather than anchored at a fixed height. useLayoutEffect (not
  // useEffect) so this resolves before paint -- no visible jump.
  useLayoutEffect(() => {
    const popoverEl = popoverRef.current;
    const wordEl = queryWord(activeWord.paragraphIdx, activeWord.wordIdx);
    const sentenceWords = querySentenceWords(activeWord.paragraphIdx, activeWord.sentenceIdx);
    if (!popoverEl || !wordEl || sentenceWords.length === 0) {
      setStyle(null);
      return;
    }

    const wordRect = wordEl.getBoundingClientRect();
    const sentenceTopRect = sentenceWords[0].getBoundingClientRect();
    const sentenceBottomRect = sentenceWords[sentenceWords.length - 1].getBoundingClientRect();
    const popoverRect = popoverEl.getBoundingClientRect();

    let top = sentenceTopRect.top - popoverRect.height - GAP_PX;
    if (top < VIEWPORT_PADDING) {
      // Not enough room above (e.g. first paragraph at the top of the
      // page) -- flip below the sentence instead. Still never covers the
      // sentence itself, just on the opposite side of it.
      top = sentenceBottomRect.bottom + GAP_PX;
    }

    let left = wordRect.left + wordRect.width / 2 - popoverRect.width / 2;
    const maxLeft = window.innerWidth - popoverRect.width - VIEWPORT_PADDING;
    left = Math.min(Math.max(left, VIEWPORT_PADDING), Math.max(maxLeft, VIEWPORT_PADDING));

    setStyle({ top, left });
  }, [activeWord, stage]);

  // Close on outside click/touch (anything that's not the popover itself
  // or the tapped word's own span -- re-tapping the same word is handled
  // by tapWord as a stage-advance, not a close) and on Escape.
  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      const wordEl = queryWord(activeWord.paragraphIdx, activeWord.wordIdx);
      if (popoverRef.current?.contains(target)) return;
      if (wordEl?.contains(target)) return;
      onClose();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // Closing on scroll rather than re-tracking position through it --
    // simplest way to avoid the card drifting stale relative to the text.
    function handleScroll() {
      onClose();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [activeWord, onClose]);

  return (
    <div
      ref={popoverRef}
      className="word-info-popover"
      role="dialog"
      aria-label={`Word info: ${activeWord.word}`}
      style={{
        position: "fixed",
        top: style?.top ?? 0,
        left: style?.left ?? 0,
        visibility: style ? "visible" : "hidden",
      }}
    >
      <div className="word-info-popover__header">{cleanHeaderWord(wordInfo, activeWord.word)}</div>
      <div className="word-info-popover__body">
        {isLoading && <span className="word-info-popover__muted">Looking it up…</span>}
        {error && !isLoading && (
          <span className="word-info-popover__error">
            {error} Tap the word again to retry.
          </span>
        )}
        {wordInfo && !isLoading && !error && <StageContent stage={stage} wordInfo={wordInfo} onReplayAudio={onReplayAudio} />}
      </div>
    </div>
  );
}

function cleanHeaderWord(wordInfo: WordInfo | null, fallback: string): string {
  if (wordInfo) return wordInfo.word;
  return fallback.replace(/^[^\p{L}\p{N}'-]+|[^\p{L}\p{N}'-]+$/gu, "").toLowerCase();
}

function StageContent({
  stage,
  wordInfo,
  onReplayAudio,
}: {
  stage: TapWordStage;
  wordInfo: WordInfo;
  onReplayAudio: () => void;
}) {
  switch (stage) {
    case "pronunciation":
      return (
        <>
          {wordInfo.ipa && <span className="word-info-popover__ipa">{wordInfo.ipa}</span>}
          {wordInfo.respelling && <span className="word-info-popover__respelling">{wordInfo.respelling}</span>}
        </>
      );
    case "definition":
      return <span>{wordInfo.definition}</span>;
    case "morphology":
      return wordInfo.morphology ? (
        <>
          <span className="word-info-popover__morphology-parts">{wordInfo.morphology.parts.join(" + ")}</span>
          <span className="word-info-popover__muted">{wordInfo.morphology.note}</span>
        </>
      ) : null;
    case "hearAloud":
      return (
        <button type="button" className="word-info-popover__replay-btn" onClick={onReplayAudio}>
          🔊 Hear it again
        </button>
      );
    case "example":
      return <span className="word-info-popover__example">{wordInfo.example_sentence}</span>;
    default:
      return null;
  }
}
