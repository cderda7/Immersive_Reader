"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Syllable } from "./types";
import { SAMPLE_SYLLABLES } from "./sampleData";

const RETURN_MODE_MS = 10_000;

// How long to hold before actually moving into the next paragraph, once a
// space press would cross a paragraph boundary. Paired with the ~0.45s CSS
// fade on .reading-paragraph (globals.css): the old paragraph's highlight
// finishes fading out inside this pause, then the new one fades in right
// after -- a deliberate "breath" at paragraph breaks instead of the same
// instant per-syllable advance used everywhere else.
const PARAGRAPH_PAUSE_MS = 600;

export function useReadingState() {
  const [syllables, setSyllables] = useState<Syllable[]>(SAMPLE_SYLLABLES);
  const [currentIndex, setCurrentIndex] = useState(0);

  const [isParagraphPause, setIsParagraphPause] = useState(false);
  const paragraphPauseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [returnMode, setReturnMode] = useState(false);
  const [returnMsLeft, setReturnMsLeft] = useState(RETURN_MODE_MS);
  const returnDeadlineRef = useRef<number | null>(null);

  const [textSize, setTextSize] = useState(18);
  const [letterSpacing, setLetterSpacing] = useState(0);
  const [lineHeight, setLineHeight] = useState(1.6);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const cancelParagraphPause = useCallback(() => {
    if (paragraphPauseTimeoutRef.current) {
      clearTimeout(paragraphPauseTimeoutRef.current);
      paragraphPauseTimeoutRef.current = null;
    }
    setIsParagraphPause(false);
  }, []);

  // Clear any pending pause timer on unmount so it can't fire (and call
  // setState) after the component's gone.
  useEffect(() => cancelParagraphPause, [cancelParagraphPause]);

  const advance = useCallback(() => {
    if (isParagraphPause) return; // space presses no-op during the pause
    const nextIndex = (currentIndex + 1) % Math.max(syllables.length, 1);
    const current = syllables[currentIndex];
    const next = syllables[nextIndex];
    const crossesParagraph = current && next && next.paragraph_idx !== current.paragraph_idx;

    if (!crossesParagraph) {
      setCurrentIndex(nextIndex);
      return;
    }

    // Hold here: currentIndex stays put (so the syllable/word highlight
    // stays anchored on the paragraph's last syllable) while the paragraph
    // highlight fades out via CSS, driven by isParagraphPause below.
    setIsParagraphPause(true);
    paragraphPauseTimeoutRef.current = setTimeout(() => {
      setCurrentIndex(nextIndex);
      setIsParagraphPause(false);
      paragraphPauseTimeoutRef.current = null;
    }, PARAGRAPH_PAUSE_MS);
  }, [currentIndex, syllables, isParagraphPause]);

  const jumpToWord = useCallback(
    (paragraphIdx: number, wordIdx: number) => {
      cancelParagraphPause();
      const target = syllables.findIndex(
        (s) => s.paragraph_idx === paragraphIdx && s.word_idx === wordIdx && s.is_first_in_word
      );
      if (target !== -1) setCurrentIndex(target);
    },
    [syllables, cancelParagraphPause]
  );

  const enterReturnMode = useCallback(() => {
    cancelParagraphPause();
    setReturnMode(true);
    returnDeadlineRef.current = Date.now() + RETURN_MODE_MS;
    setReturnMsLeft(RETURN_MODE_MS);
  }, [cancelParagraphPause]);

  const exitReturnMode = useCallback(() => {
    setReturnMode(false);
    returnDeadlineRef.current = null;
  }, []);

  // Countdown tick + auto-expire for return-to mode.
  useEffect(() => {
    if (!returnMode) return;
    const id = setInterval(() => {
      const deadline = returnDeadlineRef.current;
      if (deadline === null) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        exitReturnMode();
      } else {
        setReturnMsLeft(remaining);
      }
    }, 100);
    return () => clearInterval(id);
  }, [returnMode, exitReturnMode]);

  const handleWordClick = useCallback(
    (paragraphIdx: number, wordIdx: number) => {
      if (!returnMode) return;
      jumpToWord(paragraphIdx, wordIdx);
      exitReturnMode();
    },
    [returnMode, jumpToWord, exitReturnMode]
  );

  const loadPassage = useCallback(async (passageText: string) => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`${apiUrl}/api/syllabify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passage: passageText }),
      });
      if (!res.ok) throw new Error(`Backend returned ${res.status}`);
      const data = await res.json();
      cancelParagraphPause();
      setSyllables(data.syllables as Syllable[]);
      setCurrentIndex(0);
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? `Couldn't reach the syllabify API (${err.message}). Is the backend running (uvicorn main:app --reload)?`
          : "Couldn't reach the syllabify API."
      );
    } finally {
      setIsLoading(false);
    }
  }, [cancelParagraphPause]);

  return {
    syllables,
    currentIndex,
    advance,
    jumpToWord,
    isParagraphPause,
    returnMode,
    returnMsLeft,
    returnModeMs: RETURN_MODE_MS,
    enterReturnMode,
    exitReturnMode,
    handleWordClick,
    textSize,
    setTextSize,
    letterSpacing,
    setLetterSpacing,
    lineHeight,
    setLineHeight,
    loadPassage,
    loadError,
    isLoading,
  };
}
