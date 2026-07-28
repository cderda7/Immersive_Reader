"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Syllable } from "./types";
import { SAMPLE_SYLLABLES } from "./sampleData";

const RETURN_MODE_MS = 10_000;

export function useReadingState() {
  const [syllables, setSyllables] = useState<Syllable[]>(SAMPLE_SYLLABLES);
  const [currentIndex, setCurrentIndex] = useState(0);

  const [returnMode, setReturnMode] = useState(false);
  const [returnMsLeft, setReturnMsLeft] = useState(RETURN_MODE_MS);
  const returnDeadlineRef = useRef<number | null>(null);

  const [textSize, setTextSize] = useState(18);
  const [letterSpacing, setLetterSpacing] = useState(0);
  const [lineHeight, setLineHeight] = useState(1.6);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const advance = useCallback(() => {
    setCurrentIndex((i) => (i + 1) % Math.max(syllables.length, 1));
  }, [syllables.length]);

  const jumpToWord = useCallback(
    (paragraphIdx: number, wordIdx: number) => {
      const target = syllables.findIndex(
        (s) => s.paragraph_idx === paragraphIdx && s.word_idx === wordIdx && s.is_first_in_word
      );
      if (target !== -1) setCurrentIndex(target);
    },
    [syllables]
  );

  const enterReturnMode = useCallback(() => {
    setReturnMode(true);
    returnDeadlineRef.current = Date.now() + RETURN_MODE_MS;
    setReturnMsLeft(RETURN_MODE_MS);
  }, []);

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
  }, []);

  return {
    syllables,
    currentIndex,
    advance,
    jumpToWord,
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
