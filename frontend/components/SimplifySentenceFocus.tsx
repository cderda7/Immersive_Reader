"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AdvanceMode } from "@/lib/useReadingState";
import type { SimplifiedSentence } from "@/lib/useTapWord";
import type { SentenceFocusContext, Syllable } from "@/lib/types";
import { tiersFor } from "./ReadingPane";

interface SimplifySentenceFocusProps {
  // The tapped word's own sentence, syllable-by-syllable -- already
  // real, already-computed passage data (see lib/types.ts's
  // sentenceSyllables), unlike the simplified rewrite below, which has
  // to come from the network.
  originalSyllables: Syllable[];
  simplifiedSentence: SimplifiedSentence | null;
  isSimplifying: boolean;
  simplifyError: string | null;
  onRetrySimplify: () => void;
  advanceMode: AdvanceMode;
  context: SentenceFocusContext;
  // Manual exit (Escape / the close button / retreating past the very
  // first unit) -- no change to reading position.
  onClose: () => void;
  // Reached the end of the last SA/SB segment and pressed advance once
  // more -- reading position should continue from the sentence AFTER
  // this one, same as if the student had just kept pressing Space
  // through the passage instead of detouring in here.
  onExitContinue: () => void;
}

// One syllable, tagged with which SEGMENT of which sentence it belongs
// to -- "SA" (original) or "SB" (simplified), per product naming, plus a
// 0-based `segment` index within that sentence's own split (see
// splitIntoParts below). Together (phase, segment) is what lets this
// view reuse the exact same next/previous-unit resolution logic
// useReadingState.ts uses for the main passage (see unitDiffers/findNext/
// findPreviousFocusIndex below), just with a segment standing in for
// that hook's (paragraph_idx, sentence_idx) -- a segment boundary always
// counts as a new "unit" at sentence/paragraph granularity, exactly like
// a sentence boundary does there.
interface FocusUnit extends Syllable {
  phase: "original" | "simplified";
  segment: number;
}

// A really long sentence squeezed onto one scaled-down line reads as
// illegibly tiny (FitLine has no floor on how far it'll shrink) --
// splitting it into 2-3 pieces near each natural third/half keeps every
// line readable at a reasonable size instead of shrinking arbitrarily
// far. Thresholds are on WORD count (a sentence's rendered width isn't
// known until after layout) -- generous enough an ordinary sentence
// never gets split, but a genuine run-on (Moby Dick's "Whenever I find
// myself..." is ~90 words) gets real relief.
function targetPartCount(wordCount: number): number {
  if (wordCount > 20) return 3;
  if (wordCount > 10) return 2;
  return 1;
}

// Trailing punctuation that makes a reasonable place to break a sentence
// -- mid-sentence pauses (comma, semicolon, colon, dash), deliberately
// excluding '.'/'?'/'!' (there shouldn't be one mid-sentence, but this
// guards against ever treating a real sentence-ending period as a split
// point if one slipped in).
const BREAK_CHARS = /[,;:—–-]$/;

// Minimum words a segment can have -- keeps a boundary from landing right
// at the very start/end of the sentence and producing a near-empty
// segment nobody would recognize as its own "part."
const MIN_SEGMENT_WORDS = 2;

// Finds the word index closest to `ideal` (searching outward in both
// directions at once) whose word ends in one of BREAK_CHARS, skipping any
// index already chosen for an earlier boundary. Falls back to `ideal`
// itself (clamped into a valid range) if nothing suitable exists anywhere
// in the sentence -- a blunt word-count split beats not splitting a
// 90-word sentence at all.
function findNearestBreak(words: Syllable[][], ideal: number, existing: number[]): number {
  const w = words.length;
  const lo = MIN_SEGMENT_WORDS;
  const hi = Math.max(w - MIN_SEGMENT_WORDS, lo);
  for (let radius = 0; radius <= w; radius++) {
    const candidates = radius === 0 ? [ideal] : [ideal - radius, ideal + radius];
    for (const idx of candidates) {
      if (idx < lo || idx > hi || existing.includes(idx)) continue;
      const lastWord = words[idx - 1];
      const lastSyl = lastWord?.[lastWord.length - 1];
      if (lastSyl && BREAK_CHARS.test(lastSyl.text)) return idx;
    }
  }
  return Math.min(Math.max(ideal, lo), hi);
}

// Splits one sentence's words into `targetParts` segments, breaking at
// punctuation nearest each ideal proportional boundary (see
// findNearestBreak) -- e.g. targetParts=3 aims for breaks near the 1/3
// and 2/3 marks. Returns fewer parts than requested (down to just 1) if
// the sentence is too short to support that many MIN_SEGMENT_WORDS-sized
// pieces -- a short simplified rewrite of a long original shouldn't be
// forced into artificial slices it doesn't need.
function splitIntoParts(words: Syllable[][], targetParts: number): Syllable[][][] {
  if (targetParts <= 1 || words.length < targetParts * MIN_SEGMENT_WORDS) {
    return [words];
  }
  const boundaries: number[] = [];
  for (let k = 1; k < targetParts; k++) {
    const ideal = Math.round((words.length * k) / targetParts);
    boundaries.push(findNearestBreak(words, ideal, boundaries));
  }
  const sorted = [...new Set(boundaries)].sort((a, b) => a - b);
  const segments: Syllable[][][] = [];
  let start = 0;
  for (const b of sorted) {
    segments.push(words.slice(start, b));
    start = b;
  }
  segments.push(words.slice(start));
  return segments;
}

// One line to render in the middle third -- SA1, SB1, SA2, SB2, ... (SA =
// original, SB = simplified/"translation").
interface SegmentLine {
  phase: "original" | "simplified";
  segment: number;
  words: Syllable[][];
}

// Interleaves the two sentences' segments as SA1, SB1, SA2, SB2, ... --
// original then simplified for each matching part, per product
// direction, so the student compares one small chunk at a time instead
// of re-reading a whole sentence to find the corresponding piece later
// on. A side that ran out of segments (its sentence was too short to
// need as many parts as the other) is simply skipped for that index
// rather than padded with something empty.
function interleaveSegments(originalSegments: Syllable[][][], simplifiedSegments: Syllable[][][]): SegmentLine[] {
  const n = Math.max(originalSegments.length, simplifiedSegments.length);
  const lines: SegmentLine[] = [];
  for (let i = 0; i < n; i++) {
    if (originalSegments[i]?.length) lines.push({ phase: "original", segment: i, words: originalSegments[i] });
    if (simplifiedSegments[i]?.length) lines.push({ phase: "simplified", segment: i, words: simplifiedSegments[i] });
  }
  return lines;
}

function buildCombined(lines: SegmentLine[]): FocusUnit[] {
  const combined: FocusUnit[] = [];
  for (const line of lines) {
    for (const word of line.words) {
      for (const syl of word) {
        combined.push({ ...syl, phase: line.phase, segment: line.segment });
      }
    }
  }
  return combined;
}

// Mirrors useReadingState.ts's unitDiffers -- (phase, segment) stands in
// for that hook's (paragraph_idx, sentence_idx) pair: crossing into a new
// segment (or from original to simplified or back) always counts as a
// different unit, coarsest-first, exactly like a paragraph change does
// there.
function unitDiffers(a: FocusUnit, b: FocusUnit, mode: AdvanceMode): boolean {
  if (a.phase !== b.phase || a.segment !== b.segment) return true;
  if (mode === "word" || mode === "syllable") return a.word_idx !== b.word_idx;
  return false;
}

// Same shape as useReadingState.ts's findNextIndex, but returns null
// instead of wrapping back to 0 -- there's no "loop" here, reaching past
// the last unit means "leave the view" (see advance() below), not "start
// over."
function findNextFocusIndex(combined: FocusUnit[], index: number, mode: AdvanceMode): number | null {
  if (mode === "syllable") {
    return index + 1 < combined.length ? index + 1 : null;
  }
  const current = combined[index];
  for (let i = index + 1; i < combined.length; i++) {
    if (unitDiffers(combined[i], current, mode)) return i;
  }
  return null;
}

// Mirrors useReadingState.ts's findPreviousIndex (walk back to the start
// of the CURRENT unit first, since index isn't guaranteed to already sit
// on a boundary if advanceMode changed mid-view, then one unit further),
// returning null instead of clamping at 0 -- reaching before the first
// unit means "back out of the view entirely" (see retreat() below).
function findPreviousFocusIndex(combined: FocusUnit[], index: number, mode: AdvanceMode): number | null {
  if (mode === "syllable") {
    return index - 1 >= 0 ? index - 1 : null;
  }
  const current = combined[index];
  let unitStart = index;
  while (unitStart > 0 && !unitDiffers(combined[unitStart - 1], current, mode)) {
    unitStart--;
  }
  if (unitStart === 0) return null;
  const prevReference = combined[unitStart - 1];
  let prevStart = unitStart - 1;
  while (prevStart > 0 && !unitDiffers(combined[prevStart - 1], prevReference, mode)) {
    prevStart--;
  }
  return prevStart;
}

// Groups an already-sorted, single-sentence syllable list into words, in
// order -- a lighter version of lib/types.ts's groupSyllables that
// doesn't need the paragraph nesting that one carries, since everything
// here is already scoped to exactly one sentence's own syllables.
function groupIntoWords(syllables: Syllable[]): Syllable[][] {
  const words: Syllable[][] = [];
  let lastWordIdx: number | null = null;
  for (const s of syllables) {
    if (lastWordIdx === null || s.word_idx !== lastWordIdx) {
      words.push([]);
      lastWordIdx = s.word_idx;
    }
    words[words.length - 1].push(s);
  }
  return words;
}

export function SimplifySentenceFocus({
  originalSyllables,
  simplifiedSentence,
  isSimplifying,
  simplifyError,
  onRetrySimplify,
  advanceMode,
  context,
  onClose,
  onExitContinue,
}: SimplifySentenceFocusProps) {
  // Gate the interactive reading portion behind the simplify fetch
  // actually resolving -- the ORIGINAL sentence's syllables are already
  // in hand synchronously (real passage data, no network needed), but
  // starting the advance sequence before knowing whether there's a
  // simplified phase in front of it would mean `combined` (and therefore
  // every already-visited unitIndex) could change shape out from under
  // an in-progress read. Top/bottom context still renders immediately
  // either way -- only the interactive middle third waits.
  const ready = !isSimplifying && (simplifiedSentence !== null || simplifyError !== null);
  const simplifiedSyllables =
    simplifiedSentence?.needs_simplification && simplifiedSentence.simplified_syllables.length > 0
      ? simplifiedSentence.simplified_syllables
      : [];
  const hasSimplifiedPhase = simplifiedSyllables.length > 0;

  const originalWords = useMemo(() => groupIntoWords(originalSyllables), [originalSyllables]);
  const simplifiedWords = useMemo(() => groupIntoWords(simplifiedSyllables), [simplifiedSyllables]);

  // Both sentences split into the SAME number of parts ("mirrored") --
  // whichever one is longer decides how many parts BOTH get, so a short
  // simplified rewrite of a long original still lines up piece-for-piece
  // (SA1/SB1, SA2/SB2, ...) instead of drifting out of sync. See
  // targetPartCount/splitIntoParts above for how each sentence's own
  // actual break points are then chosen independently within that shared
  // part count.
  const targetParts = useMemo(
    () =>
      Math.max(
        targetPartCount(originalWords.length),
        hasSimplifiedPhase ? targetPartCount(simplifiedWords.length) : 1
      ),
    [originalWords.length, simplifiedWords.length, hasSimplifiedPhase]
  );
  const originalSegments = useMemo(
    () => splitIntoParts(originalWords, targetParts),
    [originalWords, targetParts]
  );
  const simplifiedSegments = useMemo(
    () => (hasSimplifiedPhase ? splitIntoParts(simplifiedWords, targetParts) : []),
    [simplifiedWords, targetParts, hasSimplifiedPhase]
  );
  const lines = useMemo(
    () => interleaveSegments(originalSegments, simplifiedSegments),
    [originalSegments, simplifiedSegments]
  );
  const combined = useMemo(() => buildCombined(lines), [lines]);

  const [unitIndex, setUnitIndex] = useState(0);
  const current = ready && combined.length > 0 ? combined[unitIndex] : null;

  function advance() {
    if (!ready || combined.length === 0) return;
    const next = findNextFocusIndex(combined, unitIndex, advanceMode);
    if (next === null) {
      onExitContinue();
      return;
    }
    setUnitIndex(next);
  }

  function retreat() {
    if (!ready || combined.length === 0) return;
    const prev = findPreviousFocusIndex(combined, unitIndex, advanceMode);
    if (prev === null) {
      onClose();
      return;
    }
    setUnitIndex(prev);
  }

  // Keyboard drives the same three keys as the rest of the app -- Space/
  // ArrowRight advance, ArrowLeft retreats, Escape closes outright. This
  // is the ONLY document-level listener active while the view is open:
  // ReadingScreen.tsx renders this component INSTEAD OF WordInfoPopover
  // (never both), so there's no other handler competing for these keys,
  // and ReadingPane's own handling already steps aside for the whole
  // time a word is active (tapWordOpen), which stays true throughout.
  const advanceRef = useRef(advance);
  const retreatRef = useRef(retreat);
  useEffect(() => {
    advanceRef.current = advance;
    retreatRef.current = retreat;
  });
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.code === "Space" || e.code === "ArrowRight") {
        e.preventDefault();
        if (e.repeat) return;
        advanceRef.current();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        if (e.repeat) return;
        retreatRef.current();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const tiers = tiersFor(advanceMode);

  // ONE shared scale per SENTENCE (not per line) -- product direction:
  // every SA segment should render at the same size as every other SA
  // segment (and likewise for SB), rather than each line independently
  // shrinking to its own natural width. Computed as the smallest scale
  // any single segment in that sentence needs (the most cramped one), then
  // applied uniformly across all of that sentence's lines -- see
  // useSharedScale below.
  const original = useSharedScale(originalSegments.length, originalSegments);
  const simplified = useSharedScale(simplifiedSegments.length, simplifiedSegments);

  return (
    <div className="simplify-focus" role="dialog" aria-label="Simplified sentence" onClick={advance}>
      <button
        type="button"
        className="simplify-focus__close"
        aria-label="Close simplified sentence view"
        // See WordInfoPopover.tsx's "Simplify sentence" button for why --
        // same fix, same reasoning: never let a click on this button move
        // DOM focus off the reading pane in the first place.
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        ✕
      </button>

      {/* Rows are wrapped in their own centered stack (separate from the
          close button and the hint line below) so a single `gap` can hold
          EVERY adjacent pair -- before-context to the simplified line,
          simplified to original, original to after-context -- to the
          exact same spacing, matching product direction that the context
          should read as leading directly into/out of the focused sentence
          rather than sitting some arbitrary distance from it. Rows with
          no content (context.before/after empty, e.g. at the very start/
          end of the passage) are skipped entirely rather than rendered
          empty, so an absent side doesn't still eat a gap for nothing. */}
      <div className="simplify-focus__stack">
        {context.before.length > 0 && (
          <div className="simplify-focus__row simplify-focus__row--context simplify-focus__row--before">
            {context.before.map((block) => (
              <p key={block.paragraphIdx} className="simplify-focus__context-paragraph">
                {block.text}
              </p>
            ))}
          </div>
        )}

        <div className="simplify-focus__row simplify-focus__row--main">
          {!ready && (
            <div className="simplify-focus__status" style={{ gridColumn: "1 / -1" }}>
              {simplifyError ? (
                <>
                  <span className="word-info-popover__error">{simplifyError}</span>
                  <button
                    type="button"
                    className="simplify-popover__btn"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRetrySimplify();
                    }}
                  >
                    Try again
                  </button>
                </>
              ) : (
                <span className="word-info-popover__muted">Simplifying…</span>
              )}
            </div>
          )}
          {ready && (
            <>
              {!hasSimplifiedPhase && (
                <div className="simplify-focus__note" style={{ gridColumn: "1 / -1" }}>
                  No simplified sentence available.
                </div>
              )}
              {lines.map((line) => {
                const isCurrentLine = current?.phase === line.phase && current?.segment === line.segment;
                const isOriginal = line.phase === "original";
                const side = isOriginal ? original : simplified;
                return (
                  <FocusLine
                    key={`${line.phase}-${line.segment}`}
                    words={line.words}
                    currentWordIdx={isCurrentLine ? current.word_idx : null}
                    currentSyllableIdx={isCurrentLine ? current.syllable_idx : null}
                    tiers={tiers}
                    variant={line.phase}
                    // Sentence mode has no per-word highlight (see tiersFor
                    // -- word/syllable tiers are both off there), so
                    // without SOME indicator the current SA/SB segment
                    // would be indistinguishable from the others now that
                    // text color no longer carries that signal either (see
                    // .simplify-focus__line's own comment). Mirrors
                    // ReadingPane.tsx's own sentence-mode convention
                    // exactly: background tint, not text color, carries
                    // "where am I" -- same --tier-word color, just applied
                    // to a whole segment line here instead of a whole
                    // sentence there. Paragraph mode intentionally gets no
                    // indicator, same as it does in the main pane.
                    tintCurrent={isCurrentLine && tiers.sentenceStyle === "backgroundTint"}
                    scale={side.scale}
                    outerRef={side.outerRef(line.segment)}
                    innerRef={side.innerRef(line.segment)}
                    // Explicit grid placement (not relying on DOM-order
                    // auto-flow) -- original always column 1, simplified
                    // always column 2, row = segment index + 1. Needed
                    // because the two sentences can end up with different
                    // segment counts (see splitIntoParts/interleaveSegments
                    // above): auto-flow would shift a later SA segment into
                    // the simplified column the moment one SB segment goes
                    // missing, since it just fills the next open cell
                    // rather than respecting which "row" a segment
                    // logically belongs to.
                    gridColumn={isOriginal ? 1 : 2}
                    gridRow={line.segment + 1}
                  />
                );
              })}
            </>
          )}
        </div>

        {context.after.length > 0 && (
          <div className="simplify-focus__row simplify-focus__row--context simplify-focus__row--after">
            {context.after.map((block) => (
              <p key={block.paragraphIdx} className="simplify-focus__context-paragraph">
                {block.text}
              </p>
            ))}
          </div>
        )}
      </div>

      <p className="simplify-focus__hint" aria-live="polite">
        Press <kbd>Space</kbd> or <kbd>→</kbd> to read, <kbd>←</kbd> to go back, <kbd>Esc</kbd> to close.
      </p>
    </div>
  );
}

// One segment line (one SA_n or SB_n -- see splitIntoParts/
// interleaveSegments), placed into its grid cell and shrunk to fit on a
// single line via a scale factor computed by useSharedScale (shared
// across every segment of the SAME sentence, not independently per
// line), with syllable/word highlighting matching the rest of the app's
// advance-by granularity (see tiersFor). Both original and simplified
// lines are always full-color/bold now (see .simplify-focus__line's own
// comment in globals.css) -- the per-word/syllable highlight (word/
// syllable mode) or the whole-line background tint (sentence mode, via
// tintCurrent) are the "current position" indicators, same mechanics the
// main reading pane itself uses.
function FocusLine({
  words,
  currentWordIdx,
  currentSyllableIdx,
  tiers,
  variant,
  tintCurrent,
  scale,
  outerRef,
  innerRef,
  gridColumn,
  gridRow,
}: {
  words: Syllable[][];
  currentWordIdx: number | null;
  currentSyllableIdx: number | null;
  tiers: { word: boolean; syllable: boolean };
  variant: "simplified" | "original";
  tintCurrent: boolean;
  scale: number;
  outerRef: (el: HTMLDivElement | null) => void;
  innerRef: (el: HTMLDivElement | null) => void;
  gridColumn: number;
  gridRow: number;
}) {
  return (
    <div
      ref={outerRef}
      className={`simplify-focus__line simplify-focus__line--${variant}${tintCurrent ? " simplify-focus__line--current" : ""}`}
      style={{ gridColumn, gridRow }}
    >
      <div
        ref={innerRef}
        className="simplify-focus__line-inner"
        style={{ transform: `scale(${scale})` }}
      >
        {words.map((sylList, wordIdx) => {
          const isCurrentWord = currentWordIdx !== null && sylList[0]?.word_idx === currentWordIdx;
          return (
            <span
              key={wordIdx}
              className={`reading-word${isCurrentWord && tiers.word ? " reading-word--current" : ""}`}
            >
              {sylList.map((syl, syllableIdx) => {
                const isCurrentSyllable = isCurrentWord && syl.syllable_idx === currentSyllableIdx;
                return (
                  <span
                    key={syllableIdx}
                    className={`reading-syllable${isCurrentSyllable && tiers.syllable ? " reading-syllable--current" : ""}`}
                  >
                    {syl.text}
                  </span>
                );
              })}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// One shared scale factor across ALL `count` segments of a single
// sentence (original or simplified), rather than each segment
// independently fitting itself to its own natural width the way the old
// FitLine did -- product direction: every SA segment should render at
// the same size as every other SA segment, so the eye doesn't have to
// keep readjusting between segments (and likewise, independently, for
// SB). Computed as the SMALLEST scale any single segment in the set
// needs (the most cramped one) via the same scrollWidth (natural,
// transform-unaffected) vs clientWidth (available) comparison FitLine
// used, just maxed across every segment instead of one.
//
// Returns ref-callback FACTORY functions (outerRef(i)/innerRef(i))
// rather than plain refs, since the caller doesn't know how many
// segments there are until render time and each segment needs its own
// stable identity to attach to -- the factories are memoized per index
// in a Map so the SAME function instance is reused across re-renders
// (a fresh callback on every render would fire spurious detach/attach
// cycles on unrelated re-renders).
interface SharedScale {
  scale: number;
  outerRef: (index: number) => (el: HTMLDivElement | null) => void;
  innerRef: (index: number) => (el: HTMLDivElement | null) => void;
}

function useSharedScale(count: number, watchKey: unknown): SharedScale {
  const outerEls = useRef<(HTMLDivElement | null)[]>([]);
  const innerEls = useRef<(HTMLDivElement | null)[]>([]);
  const outerRefFns = useRef<Map<number, (el: HTMLDivElement | null) => void>>(new Map());
  const innerRefFns = useRef<Map<number, (el: HTMLDivElement | null) => void>>(new Map());
  const [scale, setScale] = useState(1);

  // Depends on `count` and `watchKey` (the segment arrays themselves --
  // new sentence, new split) rather than running on every render like
  // FitLine did, since this now also needs to re-run after the ref
  // callbacks below have attached every segment in the set, not just one.
  useLayoutEffect(() => {
    function recompute() {
      let minScale = 1;
      for (let i = 0; i < count; i++) {
        const outer = outerEls.current[i];
        const inner = innerEls.current[i];
        if (!outer || !inner) continue;
        const naturalWidth = inner.scrollWidth;
        const available = outer.clientWidth;
        if (naturalWidth > available && naturalWidth > 0) {
          minScale = Math.min(minScale, available / naturalWidth);
        }
      }
      setScale(minScale);
    }
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, watchKey]);

  function outerRef(index: number) {
    let fn = outerRefFns.current.get(index);
    if (!fn) {
      fn = (el) => {
        outerEls.current[index] = el;
      };
      outerRefFns.current.set(index, fn);
    }
    return fn;
  }

  function innerRef(index: number) {
    let fn = innerRefFns.current.get(index);
    if (!fn) {
      fn = (el) => {
        innerEls.current[index] = el;
      };
      innerRefFns.current.set(index, fn);
    }
    return fn;
  }

  return { scale, outerRef, innerRef };
}
