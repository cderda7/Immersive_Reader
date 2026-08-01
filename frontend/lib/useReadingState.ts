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

// Which unit size the spacebar/click advances by, chosen from the
// settings panel (ControlBar.tsx's "Advance by" group). Coarsest to
// finest: paragraph -> sentence -> word -> syllable. Highlighting in
// ReadingPane.tsx is gated off this same value, cumulatively from
// paragraph down through whichever level is selected -- see that file's
// tiersFor().
export type AdvanceMode = "syllable" | "word" | "sentence" | "paragraph";

// Finds the flat-list index of the START of the next unit at the given
// granularity, scanning forward from currentIndex. Syllable mode is the
// simple case (just the next array slot, wrapping at the end); the other
// three modes scan for the next entry whose relevant *_idx differs from
// the current one's -- which, because the flat list is sorted
// (paragraph, sentence, word, syllable), is guaranteed to land exactly
// on that next unit's first syllable, not somewhere in its middle.
// Wraps to 0 (start of the passage) if nothing further differs, matching
// syllable mode's modulo wraparound.
function findNextIndex(syllables: Syllable[], currentIndex: number, mode: AdvanceMode): number {
  if (mode === "syllable") return (currentIndex + 1) % Math.max(syllables.length, 1);
  const current = syllables[currentIndex];
  if (!current) return 0;
  for (let i = currentIndex + 1; i < syllables.length; i++) {
    if (unitDiffers(syllables[i], current, mode)) return i;
  }
  return 0;
}

// Whether `a` belongs to a different unit than `b` at the given
// granularity. A paragraph change always counts as a difference
// regardless of mode (paragraph is the coarsest unit, everything finer
// lives inside it); word mode additionally requires the same
// sentence_idx to match, matching sentence_idx/word_idx's existing
// paragraph-relative-reset convention (see backend/syllabify.py).
function unitDiffers(a: Syllable, b: Syllable, mode: AdvanceMode): boolean {
  if (a.paragraph_idx !== b.paragraph_idx) return true;
  if (mode === "paragraph") return false;
  if (a.sentence_idx !== b.sentence_idx) return true;
  if (mode === "sentence") return false;
  return a.word_idx !== b.word_idx; // mode === "word"
}

// Mirrors findNextIndex, but walks backward to the start of the PREVIOUS
// unit at the given granularity. Not a simple "scan backward for the first
// differing index" -- currentIndex isn't guaranteed to already sit on a
// unit boundary for the *current* advanceMode (the student may have
// switched modes mid-passage), so this first locates the start of the
// unit currentIndex is inside, then steps back one more unit from there.
// Clamps at 0 rather than wrapping to the passage's last unit -- unlike
// forward's wraparound (a convenience for looping the short demo
// passage), wrapping backward past the beginning to the end of a whole
// book chapter would be disorienting, not useful.
function findPreviousIndex(syllables: Syllable[], currentIndex: number, mode: AdvanceMode): number {
  if (mode === "syllable") return Math.max(currentIndex - 1, 0);
  const current = syllables[currentIndex];
  if (!current) return 0;

  // Walk back to the start of the unit currentIndex is inside.
  let unitStart = currentIndex;
  while (unitStart > 0 && !unitDiffers(syllables[unitStart - 1], current, mode)) {
    unitStart--;
  }
  if (unitStart === 0) return 0;

  // Then walk back one more unit from just before that start.
  const prevReference = syllables[unitStart - 1];
  let prevStart = unitStart - 1;
  while (prevStart > 0 && !unitDiffers(syllables[prevStart - 1], prevReference, mode)) {
    prevStart--;
  }
  return prevStart;
}

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

  // Paragraph is the coarsest granularity and the friendliest default for
  // a first-time student (fewer, bigger pauses before they've found their
  // footing with the controls) -- they can drop down to sentence/word/
  // syllable from the control bar once they're ready to slow down.
  const [advanceMode, setAdvanceMode] = useState<AdvanceMode>("paragraph");

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
    // during ANY pause (sentence- or paragraph-kind): that means the
    // student expects to already be on the next syllable, so instead of
    // eating it silently we interrupt with the breath-error sequence --
    // "take a breath" should land at the end of every sentence, and a
    // paragraph-crossing pause is always also a sentence-ending one.
    // BUT that mismatch story only makes sense in Syllable/Word mode,
    // where a sentence-crossing pause is still the rare exception to an
    // otherwise fine-grained pace. In Sentence/Paragraph mode, a
    // sentence- or paragraph-type pause fires on literally EVERY step
    // (see findNextIndex/unitDiffers below) -- it's not a desync anymore,
    // it's just the mode's normal rhythm, so a rushed press there is
    // plain impatience, not a mismatch. Treat it as the same silent
    // no-op it already gets in every mode.
    if (pauseKindRef.current) {
      if (advanceMode === "syllable" || advanceMode === "word") {
        triggerBreathError();
      }
      return;
    }

    const nextIndex = findNextIndex(syllables, currentIndex, advanceMode);
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
  }, [currentIndex, syllables, advanceMode, triggerBreathError]);

  // Steps back to the start of the previous unit at the current
  // granularity. Deliberately has none of advance()'s pause/breath-error
  // machinery -- that system exists to slow down rushing FORWARD past a
  // boundary; stepping backward to re-check something is a correction,
  // not a pacing violation. So retreat() never calls triggerBreathError(),
  // and treats an in-flight pause as something to cancel and step past
  // rather than something to be blocked by (same cancelPause() jumpToWord
  // already uses). The one thing it still respects is the breath-error
  // hold itself: while that's actively playing, retreat is blocked exactly
  // like advance is -- once "take a breath" has started, nothing exits it
  // early except its own timer.
  const retreat = useCallback(() => {
    if (isBreathErrorRef.current) return;

    cancelPause();

    const previousIndex = findPreviousIndex(syllables, currentIndex, advanceMode);
    setCurrentIndex(previousIndex);
  }, [currentIndex, syllables, advanceMode, cancelPause]);

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

  // Curated-library counterpart to loadPassage above: fetches a
  // pre-ingested chapter/scene's static syllable JSON directly (same-
  // origin static asset under frontend/public/library/, generated by
  // backend/ingest_book.py) instead of POSTing raw text to the live
  // /api/syllabify route. Shares the same reset path (cancelPause,
  // setSyllables, setCurrentIndex(0)) and the same isLoading/loadError
  // state as loadPassage -- from ReadingPane/ControlBar's point of view
  // this is just another way syllables gets populated, nothing
  // downstream needs to know which path was used. Works even if the
  // FastAPI backend isn't running, since it never talks to it.
  const loadChapter = useCallback(async (bookSlug: string, chapterId: string) => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/library/${bookSlug}/${chapterId}.json`);
      if (!res.ok) throw new Error(`Chapter file returned ${res.status}`);
      const data = await res.json();
      cancelPause();
      setSyllables(data as Syllable[]);
      setCurrentIndex(0);
    } catch (err) {
      setLoadError(
        err instanceof Error ? `Couldn't load that chapter (${err.message}).` : "Couldn't load that chapter."
      );
    } finally {
      setIsLoading(false);
    }
  }, [cancelPause]);

  return {
    syllables,
    currentIndex,
    advance,
    retreat,
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
    advanceMode,
    setAdvanceMode,
    textSize,
    setTextSize,
    letterSpacing,
    setLetterSpacing,
    lineHeight,
    setLineHeight,
    loadPassage,
    loadChapter,
    loadError,
    isLoading,
  };
}
