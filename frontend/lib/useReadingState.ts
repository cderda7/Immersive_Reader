"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Syllable } from "./types";
import { SAMPLE_SYLLABLES } from "./sampleData";

const RETURN_MODE_MS = 10_000;

// How long to hold before auto-advancing across a boundary, keyed by which
// boundary it is. The student can't skip ahead by pressing space during the
// hold (fully blocked, see pauseKindRef below), but doesn't need to press
// anything once it elapses either -- reaching the end of the window IS what
// advances. For a sentence crossing, this is also the exact duration of the
// color-fade preview in ReadingPane.tsx (sentence1 fading toward gray,
// sentence2 fading toward full focus) -- the two are driven off the same
// constant on purpose, so the fade finishing is a true signal that the
// pause is over, not just a decorative animation with its own timing.
export const PARAGRAPH_PAUSE_MS = 600;
export const SENTENCE_PAUSE_MS = 300;

// A rushed space-press during a SENTENCE pause means the student expected
// to already be on a new syllable -- pressing again from there would
// desync the highlight from the sentence that's about to load. Instead of
// silently eating the press, this plays a calming "breath" interruption:
// the passage fades to deep green with the message, holds, fades back out,
// then resets to the start of the paragraph that got interrupted. FADE_MS
// is exported so BreathBanner.tsx's CSS transition stays in lockstep with
// the timer that drives it, same pattern as SENTENCE_PAUSE_MS above.
export const BREATH_ERROR_FADE_MS = 900;
const BREATH_ERROR_HOLD_MS = 1200;
const BREATH_ERROR_TOTAL_MS = BREATH_ERROR_FADE_MS * 2 + BREATH_ERROR_HOLD_MS;

type PauseKind = "paragraph" | "sentence" | null;
type SentenceRef = { paragraphIdx: number; sentenceIdx: number } | null;

export function useReadingState() {
  const [syllables, setSyllables] = useState<Syllable[]>(SAMPLE_SYLLABLES);
  const [currentIndex, setCurrentIndex] = useState(0);

  const [pauseKind, setPauseKindState] = useState<PauseKind>(null);
  const pauseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mirrors pauseKind, but as a ref: state only updates on the next
  // re-render, so gating advance() on the *state* value leaves a window
  // where a rapid-fire space press (OS key-repeat easily outruns a React
  // render) still reads the pre-pause value and slips through. A ref
  // mutates synchronously the instant setPauseKind runs, closing that
  // window completely -- advance() checks the ref; pauseKind state is
  // kept only to drive rendering (isParagraphPause/isSentencePause below).
  const pauseKindRef = useRef<PauseKind>(null);
  const setPauseKind = useCallback((kind: PauseKind) => {
    pauseKindRef.current = kind;
    setPauseKindState(kind);
  }, []);

  // Which sentence a pending sentence-crossing is headed toward, set for
  // the duration of the pause so ReadingPane can pre-fade it into focus
  // (rendering-only -- no race-safety need, plain state is fine here).
  const [pendingSentence, setPendingSentence] = useState<SentenceRef>(null);

  // Same synchronous-ref pattern as pauseKindRef, for the same reason: a
  // key-repeat press can arrive before React re-renders, so gating on
  // state alone would let a second press slip through mid-sequence and
  // restart or double-fire the reset. isBreathErrorRef is the source of
  // truth advance() checks; isBreathError state just drives BreathBanner.
  const [isBreathError, setIsBreathErrorState] = useState(false);
  const isBreathErrorRef = useRef(false);
  const setIsBreathError = useCallback((val: boolean) => {
    isBreathErrorRef.current = val;
    setIsBreathErrorState(val);
  }, []);
  const breathErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [returnMode, setReturnMode] = useState(false);
  const [returnMsLeft, setReturnMsLeft] = useState(RETURN_MODE_MS);
  const returnDeadlineRef = useRef<number | null>(null);

  const [textSize, setTextSize] = useState(18);
  const [letterSpacing, setLetterSpacing] = useState(0);
  const [lineHeight, setLineHeight] = useState(1.6);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const cancelPause = useCallback(() => {
    if (pauseTimeoutRef.current) {
      clearTimeout(pauseTimeoutRef.current);
      pauseTimeoutRef.current = null;
    }
    setPendingSentence(null);
    setPauseKind(null);
    if (breathErrorTimeoutRef.current) {
      clearTimeout(breathErrorTimeoutRef.current);
      breathErrorTimeoutRef.current = null;
    }
    setIsBreathError(false);
  }, [setPauseKind, setIsBreathError]);

  // Clear any pending pause timer on unmount so it can't fire (and call
  // setState) after the component's gone.
  useEffect(() => cancelPause, [cancelPause]);

  // Aborts the in-flight sentence pause the rushed press interrupted, shows
  // the calming green "breathe" overlay, then -- once it's held and faded
  // back out -- resets currentIndex to word 1 of sentence 1 of whichever
  // paragraph got interrupted (word_idx resets per paragraph, so word_idx
  // 0/syllable_idx 0 within that paragraph_idx is exactly that word).
  const triggerBreathError = useCallback(() => {
    if (pauseTimeoutRef.current) {
      clearTimeout(pauseTimeoutRef.current);
      pauseTimeoutRef.current = null;
    }
    setPendingSentence(null);
    setPauseKind(null);

    const interruptedParagraphIdx = syllables[currentIndex]?.paragraph_idx;
    setIsBreathError(true);

    breathErrorTimeoutRef.current = setTimeout(() => {
      if (interruptedParagraphIdx !== undefined) {
        const target = syllables.findIndex(
          (s) => s.paragraph_idx === interruptedParagraphIdx && s.word_idx === 0 && s.syllable_idx === 0
        );
        if (target !== -1) setCurrentIndex(target);
      }
      setIsBreathError(false);
      breathErrorTimeoutRef.current = null;
    }, BREATH_ERROR_TOTAL_MS);
  }, [currentIndex, syllables, setPauseKind, setIsBreathError]);

  const advance = useCallback(() => {
    // Fully blocked while the breath-error sequence plays -- same
    // synchronous-ref reasoning as pauseKindRef below.
    if (isBreathErrorRef.current) return;

    // Checked against the ref, not the pauseKind state -- see the comment
    // by pauseKindRef above. This is what makes the pause an actual block:
    // without it, a space press that arrives before React's next render
    // (key-repeat fires far faster than a render cycle) would still see
    // "not paused" and sail through. Any press during the hold, however
    // many, is a pure no-op -- the hold only ends when the timer below
    // fires, not in response to a press. The one exception is a press
    // during a SENTENCE pause specifically: that means the student expects
    // to already be on the next syllable, so instead of eating it silently
    // we interrupt with the breath-error sequence (paragraph pauses are
    // left alone -- no mismatch risk there, nothing to jump ahead of).
    if (pauseKindRef.current) {
      if (pauseKindRef.current === "sentence") {
        triggerBreathError();
      }
      return;
    }

    const nextIndex = (currentIndex + 1) % Math.max(syllables.length, 1);
    const current = syllables[currentIndex];
    const next = syllables[nextIndex];
    const crossesParagraph = current && next && next.paragraph_idx !== current.paragraph_idx;
    // A paragraph change is always also a sentence change (sentence_idx
    // resets per paragraph) -- only treat it as a *sentence* crossing when
    // it's a sentence break within the same paragraph, so it gets the
    // shorter pause instead of double-pausing on top of the paragraph one.
    const crossesSentence =
      !crossesParagraph && current && next && next.sentence_idx !== current.sentence_idx;

    if (!crossesParagraph && !crossesSentence) {
      setCurrentIndex(nextIndex);
      return;
    }

    // Hold here: currentIndex stays put (so word/syllable highlight stays
    // anchored where it was) while ReadingPane fades sentence1 toward gray
    // and sentence2 (pendingSentence, for a sentence crossing) toward full
    // focus. When the timer fires, that fade is complete -- the jump below
    // just continues seamlessly from where the fade already left off.
    const kind: PauseKind = crossesParagraph ? "paragraph" : "sentence";
    setPauseKind(kind);
    if (kind === "sentence") {
      setPendingSentence({ paragraphIdx: next.paragraph_idx, sentenceIdx: next.sentence_idx });
    }
    pauseTimeoutRef.current = setTimeout(
      () => {
        setCurrentIndex(nextIndex);
        setPendingSentence(null);
        setPauseKind(null);
        pauseTimeoutRef.current = null;
      },
      crossesParagraph ? PARAGRAPH_PAUSE_MS : SENTENCE_PAUSE_MS
    );
    // Note: pauseKind (state) is intentionally NOT a dependency here --
    // the guard above reads pauseKindRef instead specifically so this
    // callback doesn't need to be recreated (and re-propagated through a
    // render) just to pick up the latest pause status.
  }, [currentIndex, syllables, triggerBreathError]);

  const jumpToWord = useCallback(
    (paragraphIdx: number, wordIdx: number) => {
      cancelPause();
      const target = syllables.findIndex(
        (s) => s.paragraph_idx === paragraphIdx && s.word_idx === wordIdx && s.is_first_in_word
      );
      if (target !== -1) setCurrentIndex(target);
    },
    [syllables, cancelPause]
  );

  const enterReturnMode = useCallback(() => {
    cancelPause();
    setReturnMode(true);
    returnDeadlineRef.current = Date.now() + RETURN_MODE_MS;
    setReturnMsLeft(RETURN_MODE_MS);
  }, [cancelPause]);

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
      cancelPause();
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
  }, [cancelPause]);

  return {
    syllables,
    currentIndex,
    advance,
    jumpToWord,
    isParagraphPause: pauseKind === "paragraph",
    isSentencePause: pauseKind === "sentence",
    pendingSentence,
    isBreathError,
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
