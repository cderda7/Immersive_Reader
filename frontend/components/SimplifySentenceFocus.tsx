"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

// One syllable, tagged with which SIDE it belongs to -- "SA" (original)
// or "SB" (simplified), per product naming, plus a 0-based `segment`
// index within that sentence's own CLAUSE split (see splitIntoClauses
// below). Together (phase, segment) is what lets this view reuse the
// exact same next/previous-unit resolution logic useReadingState.ts uses
// for the main passage (see unitDiffers/findNext/findPreviousFocusIndex
// below), just with a clause standing in for that hook's (paragraph_idx,
// sentence_idx) -- a clause boundary always counts as a new "unit" at
// sentence/paragraph granularity, exactly like a sentence boundary does
// there.
interface FocusUnit extends Syllable {
  phase: "original" | "simplified";
  segment: number;
}

// One line to render in the middle third -- SA1, SB1, SA2, SB2, ... (SA =
// original, SB = simplified/"translation"), one pair per CLAUSE (see
// splitIntoClauses below). `dashPrefix` is set (to the actual dash
// character used) on a simplified line whose ORIGINAL counterpart clause
// opens with a leading dash but whose own rewritten text doesn't -- see
// leadingDash/interleaveSegments below.
interface SegmentLine {
  phase: "original" | "simplified";
  segment: number;
  words: Syllable[][];
  dashPrefix?: string;
}

// Whether `words` opens with a leading dash ("- some clause...", a
// dash-led list item), and if so, which dash character it uses. Some
// passages format a clause this way; when the ORIGINAL clause at a given
// index opens with one, its simplified counterpart should too, even
// though a rewrite is free to change everything else about the wording
// -- the leading dash is part of the sentence's STRUCTURE, same category
// as the clause punctuation splitIntoClauses reads, not part of the
// content a simplification is meant to reword. Checks just the first
// word's leading character(s) rather than requiring the dash to be its
// own separate word/token, since either could show up in the syllable
// data depending on how the passage was authored/syllabified.
function leadingDash(words: Syllable[][]): string | null {
  const first = words[0]?.[0];
  if (!first) return null;
  const match = /^([-–—])/.exec(first.text);
  return match ? match[1] : null;
}

// Clause-ending punctuation that marks a natural STRUCTURAL break inside
// a sentence -- a semicolon-joined list of parallel clauses ("Some
// leaning against the spiles; some seated upon the pier-heads; ..."), or
// a colon introducing one. Deliberately NOT a comma: commas are common
// enough inside an ordinary single clause (lists, appositives,
// subordinate clauses) that breaking on every one would fragment normal
// sentences the same way the old proportional splitter over-fragmented
// them -- this is for real clause/sentence boundaries, not every pause.
const CLAUSE_BREAK_CHARS = /[;:]$/;

// Same idea, but for a period -- only counts as a clause break when it's
// NOT the very last word of the sentence. A plain sentence's own final
// period isn't a structural break; an INTERNAL period is, which happens
// when a simplified rewrite turns one semicolon-joined original sentence
// into several short simple ones ("Some people leaned against the wooden
// posts. Some sat on the ends of the pier. ..." -- still just one
// `simplifiedSentence` API-wise, syllabified as a single blob).
function isClauseBreak(word: Syllable[], isLastWord: boolean): boolean {
  const lastSyl = word[word.length - 1];
  if (!lastSyl) return false;
  if (CLAUSE_BREAK_CHARS.test(lastSyl.text)) return true;
  return !isLastWord && lastSyl.text.endsWith(".");
}

// Splits one sentence's words into one segment per CLAUSE, breaking
// AFTER every word that ends a clause (see isClauseBreak) -- structural
// punctuation the sentence ALREADY has, not an artificial word-count
// target. This is what keeps the original's semicolon-separated clauses
// and the simplified rewrite's period-separated sentences each on their
// own line, in the SAME relative order, rather than either running
// together or getting cut apart from its natural boundaries by an
// unrelated width-based wrap. A sentence with no internal clause
// punctuation at all comes back as a single segment (still free to wrap
// across multiple lines on its own -- see .simplify-focus__line-inner in
// globals.css -- if it's long, just not split into separate clause
// rows).
function splitIntoClauses(words: Syllable[][]): Syllable[][][] {
  const segments: Syllable[][][] = [];
  let current: Syllable[][] = [];
  words.forEach((word, i) => {
    current.push(word);
    if (isClauseBreak(word, i === words.length - 1)) {
      segments.push(current);
      current = [];
    }
  });
  if (current.length > 0) segments.push(current);
  return segments;
}

// A softer structural break than isClauseBreak -- just a trailing comma.
// Used ONLY as a fallback (see splitToClauseCount below) when a
// simplified rewrite needs to match the ORIGINAL's clause count but
// doesn't have enough of its own semicolons/colons/internal periods to
// get there on its own -- a rewrite commonly turns a semicolon-joined
// original into ONE flowing, comma-joined sentence instead of keeping
// the original's stronger punctuation (exactly what happens turning
// "whenever X; whenever Y; ..." into "whenever X, whenever Y, ..."). Not
// part of splitIntoClauses/isClauseBreak itself -- see that function's
// own comment on why an ordinary comma is too common inside a single
// clause to trust as a structural signal on its own; it's only safe to
// reach for here because the TARGET COUNT is already fixed by the
// original, so there's a known number of real breaks to look for instead
// of guessing how many a comma alone implies.
function isSoftBreak(word: Syllable[]): boolean {
  const lastSyl = word[word.length - 1];
  return !!lastSyl && lastSyl.text.endsWith(",");
}

// Finds the word-boundary index (the index one past a candidate word)
// nearest `ideal`, searching outward in both directions at once, whose
// word satisfies `test` and isn't already in `existing`. Returns null if
// nothing satisfies `test` anywhere in the sentence. Boundary `idx` sits
// after word `idx - 1`, so idx ranges from MIN_SEGMENT_WORDS to
// `words.length - MIN_SEGMENT_WORDS` -- same margin splitIntoClauses'
// old proportional predecessor used, to keep a boundary from landing
// right at the very start/end and producing a near-empty piece.
const MIN_SEGMENT_WORDS = 2;
function findNearestMatch(
  words: Syllable[][],
  ideal: number,
  existing: number[],
  test: (word: Syllable[]) => boolean
): number | null {
  const lo = MIN_SEGMENT_WORDS;
  const hi = Math.max(words.length - MIN_SEGMENT_WORDS, lo);
  for (let radius = 0; radius <= words.length; radius++) {
    const candidates = radius === 0 ? [ideal] : [ideal - radius, ideal + radius];
    for (const idx of candidates) {
      if (idx < lo || idx > hi || existing.includes(idx)) continue;
      if (test(words[idx - 1])) return idx;
    }
  }
  return null;
}

// Splits `words` into EXACTLY `targetCount` segments (fewer only if the
// sentence is too short to support that many non-trivial pieces) --
// unlike splitIntoClauses above, which only breaks where the sentence's
// OWN punctuation says to and can come back with fewer pieces than that,
// this is for the specific case where a simplified rewrite needs to
// MATCH the original's clause count (see the FORMATTING RULE on
// simplifiedSegments below) but didn't naturally produce enough clause
// breaks of its own to get there. For each of the `targetCount - 1`
// breaks needed, prefers a REAL strong clause break (isClauseBreak)
// nearest that ideal proportional position, falls back to a softer comma
// (isSoftBreak) nearest the same position if no strong one is anywhere
// in the sentence, and only falls back to the bare ideal position itself
// (a blunt word-count cut) if the sentence has neither -- always prefers
// punctuation the text already has over an arbitrary cut, in that order.
function splitToClauseCount(words: Syllable[][], targetCount: number): Syllable[][][] {
  if (targetCount <= 1 || words.length < targetCount * MIN_SEGMENT_WORDS) {
    return [words];
  }
  const boundaries: number[] = [];
  for (let k = 1; k < targetCount; k++) {
    const ideal = Math.round((words.length * k) / targetCount);
    const strong = findNearestMatch(words, ideal, boundaries, (w) => isClauseBreak(w, false));
    const soft = strong ?? findNearestMatch(words, ideal, boundaries, isSoftBreak);
    boundaries.push(soft ?? Math.min(Math.max(ideal, MIN_SEGMENT_WORDS), words.length - MIN_SEGMENT_WORDS));
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

// The clause-JOINING punctuation character a NON-FINAL clause segment
// ends in -- ';', ':', or ',' -- or null if (unusually) it doesn't end
// that way. Deliberately excludes '.': a period at the end of the LAST
// segment is how the sentence ITSELF ends, not a joining mark between
// clauses, and this is only ever called on non-final segments anyway
// (see withMatchingJoiningPunct below).
function joiningPunct(segment: Syllable[][]): string | null {
  const lastWord = segment[segment.length - 1];
  const lastSyl = lastWord?.[lastWord.length - 1];
  if (!lastSyl) return null;
  const match = /([;:,])$/.exec(lastSyl.text);
  return match ? match[1] : null;
}

// Rewrites a clause segment's own trailing joining-punctuation character
// (if any) to `desiredPunct`, returning a NEW segment (shallow-copied
// down to the one changed syllable) rather than mutating the source --
// word_idx/syllable_idx, what advance/highlight logic actually keys off,
// stay untouched; only the displayed `text` of that one syllable changes.
// A no-op if `desiredPunct` is null (nothing to match) or already matches.
function withMatchingJoiningPunct(segment: Syllable[][], desiredPunct: string | null): Syllable[][] {
  if (!desiredPunct) return segment;
  const lastWordIdx = segment.length - 1;
  const lastWord = segment[lastWordIdx];
  const lastSylIdx = lastWord?.length - 1;
  const lastSyl = lastWord?.[lastSylIdx];
  if (!lastSyl) return segment;
  const newText = lastSyl.text.replace(/[;:,]$/, "") + desiredPunct;
  if (newText === lastSyl.text) return segment;
  const newSegment = [...segment];
  const newWord = [...lastWord];
  newWord[lastSylIdx] = { ...lastSyl, text: newText };
  newSegment[lastWordIdx] = newWord;
  return newSegment;
}

// Interleaves the two sentences' clause segments as SA1, SB1, SA2, SB2,
// ... -- original then simplified for each matching clause, per product
// direction, so the student compares one clause/short-sentence at a time
// instead of re-reading a whole compound sentence to find the
// corresponding piece later on. The ORIGINAL's clause count is
// authoritative -- the caller (see simplifiedSegments below) forces the
// simplified side to match it via splitToClauseCount whenever its own
// punctuation alone would produce fewer pieces, so a mismatch here is
// now the exception rather than the norm; this function still tolerates
// one (a side simply skipped for that row rather than padded with
// something empty) for the one direction that's still allowed to vary --
// a rewrite whose OWN punctuation happens to produce MORE pieces than
// the original isn't forced down to match, since merging real structure
// away would lose information the split was trying to preserve. Also
// carries a simplified line's dashPrefix over from its original
// counterpart at the SAME index (see leadingDash above) -- comparing
// same-index clauses here, rather than leaving it to the caller, is what
// keeps that lookup correct even when the two sides' clause counts don't
// match.
function interleaveSegments(originalSegments: Syllable[][][], simplifiedSegments: Syllable[][][]): SegmentLine[] {
  const n = Math.max(originalSegments.length, simplifiedSegments.length);
  const lines: SegmentLine[] = [];
  for (let i = 0; i < n; i++) {
    if (originalSegments[i]?.length) lines.push({ phase: "original", segment: i, words: originalSegments[i] });
    if (simplifiedSegments[i]?.length) {
      const originalDash = originalSegments[i] ? leadingDash(originalSegments[i]) : null;
      const dashPrefix = originalDash && !leadingDash(simplifiedSegments[i]) ? originalDash : undefined;
      lines.push({ phase: "simplified", segment: i, words: simplifiedSegments[i], dashPrefix });
    }
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
// for that hook's (paragraph_idx, sentence_idx) pair: crossing from the
// original sentence into the simplified one (or back) always counts as a
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

  // FORMATTING RULE (product direction): FIXED text size, always -- see
  // .simplify-focus__line-inner in globals.css, which sets one constant
  // font-size and never shrinks or scales it. Each CLAUSE (see
  // splitIntoClauses above) renders as an ordinary wrapping block of text
  // at that fixed size -- a long clause just gets MORE LINES of its own,
  // via the browser's own line-breaking, which already greedily packs as
  // many words onto each line as fit before wrapping to the next (the
  // same algorithm any paragraph of text uses). That's the "greedy fit"
  // this needs, for free, in one layout pass, with no custom measure/
  // shrink/grow loop of ours that could over- or under-fragment it --
  // splitIntoClauses' own job is a DIFFERENT, coarser one (deciding
  // clause rows from the sentence's actual punctuation, not deciding
  // where lines wrap within a clause).
  //
  // (An earlier version of this view force-fit each sentence onto
  // exactly one line -- shrinking it with `transform: scale()`, then
  // splitting it into more same-size pieces when even that got
  // illegibly small -- which needed real machinery to get right and
  // still under-packed lines sometimes, since splitting divided words
  // evenly across pieces rather than packing each line as full as
  // possible, ignoring the sentence's own structure entirely. Splitting
  // on actual clause punctuation, then letting each clause wrap on its
  // own, fixes both problems at once.)
  const originalSegments = useMemo(() => splitIntoClauses(originalWords), [originalWords]);
  // The simplified rewrite is free to reword the original however it
  // likes, but its LINE STRUCTURE should still match the original's --
  // see splitIntoClauses' own comment on why (comparing one clause/short
  // sentence at a time, not a whole compound sentence). A rewrite often
  // doesn't reach for the same strong punctuation the original used to
  // mark that structure (turning "whenever X; whenever Y; ..." into one
  // comma-joined "whenever X, whenever Y, ..." sentence is a real
  // example, not a hypothetical one), so splitIntoClauses alone can come
  // back with fewer pieces than the original has. Only step in with
  // splitToClauseCount -- which forces a match by falling back to comma
  // breaks, and failing that, plain word-position cuts -- when that
  // happens; if the rewrite's OWN punctuation already produces AT LEAST
  // as many pieces as the original, trust it as-is (see interleaveSegments'
  // own comment on why that direction isn't forced).
  //
  // FORMATTING RULE (product direction): the simplified sentence's
  // JOINING punctuation should match the original's, clause for clause --
  // not just the same NUMBER of clauses, the same MARK. A rewrite that
  // turns "whenever X; whenever Y; ..." into "whenever X, whenever Y,
  // ..." has matching structure by count already (handled above), but
  // still reads as punctuated differently from the original it's meant
  // to mirror. For every clause but the last (the last one ends the
  // SENTENCE, not a join to the next clause -- its own terminal
  // punctuation is left alone), withMatchingJoiningPunct swaps in
  // whatever character the ORIGINAL clause at that same index used. Only
  // applies where there IS an original counterpart at that index (a
  // simplified clause beyond the original's own count -- see the
  // natural-count branch above -- has no original mark to match, so it's
  // left as the rewrite wrote it).
  const simplifiedSegments = useMemo(() => {
    if (!hasSimplifiedPhase) return [];
    const natural = splitIntoClauses(simplifiedWords);
    const matched =
      natural.length >= originalSegments.length ? natural : splitToClauseCount(simplifiedWords, originalSegments.length);
    return matched.map((segment, i) => {
      const isFinal = i === matched.length - 1;
      if (isFinal) return segment;
      return withMatchingJoiningPunct(segment, joiningPunct(originalSegments[i] ?? []));
    });
  }, [simplifiedWords, hasSimplifiedPhase, originalSegments]);
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
                return (
                  <FocusLine
                    key={`${line.phase}-${line.segment}`}
                    words={line.words}
                    dashPrefix={line.dashPrefix ?? null}
                    currentWordIdx={isCurrentLine ? current.word_idx : null}
                    currentSyllableIdx={isCurrentLine ? current.syllable_idx : null}
                    tiers={tiers}
                    variant={line.phase}
                    // Sentence mode has no per-word highlight (see tiersFor
                    // -- word/syllable tiers are both off there), so
                    // without SOME indicator the current SA/SB clause
                    // would be indistinguishable from the others now that
                    // text color no longer carries that signal either (see
                    // .simplify-focus__line's own comment). Mirrors
                    // ReadingPane.tsx's own sentence-mode convention
                    // exactly: background tint, not text color, carries
                    // "where am I" -- same --tier-word color, just applied
                    // to a whole clause block here instead of a whole
                    // sentence there. Paragraph mode intentionally gets no
                    // indicator, same as it does in the main pane.
                    tintCurrent={isCurrentLine && tiers.sentenceStyle === "backgroundTint"}
                    // Explicit grid placement (not relying on DOM-order
                    // auto-flow) -- original always column 1, simplified
                    // always column 2, row = that clause's own index + 1
                    // (see splitIntoClauses above). Needed because the two
                    // sentences can end up with different clause counts:
                    // auto-flow would shift a later SA clause into the
                    // simplified column the moment one SB clause goes
                    // missing, since it just fills the next open cell
                    // rather than respecting which "row" a clause
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

// One sentence's block (SA or SB), placed into its grid cell and left to
// wrap normally at a fixed size (see .simplify-focus__line-inner and the
// FORMATTING RULE comment above), with syllable/word highlighting
// matching the rest of the app's advance-by granularity (see tiersFor).
// Both original and simplified lines are always full-color/bold now (see
// .simplify-focus__line's own comment in globals.css) -- the per-word/
// syllable highlight (word/syllable mode) or the whole-block background
// tint (sentence mode, via tintCurrent) are the "current position"
// indicators, same mechanics the main reading pane itself uses.
function FocusLine({
  words,
  dashPrefix,
  currentWordIdx,
  currentSyllableIdx,
  tiers,
  variant,
  tintCurrent,
  gridColumn,
  gridRow,
}: {
  words: Syllable[][];
  // Set only on a simplified clause whose original counterpart opens
  // with a dash but whose own (rewritten) text doesn't -- see
  // leadingDash/interleaveSegments above. Rendered as plain text, not
  // wired into currentWordIdx/currentSyllableIdx, since it isn't backed
  // by real syllable data of its own -- it's a structural echo of the
  // original, not content of this sentence to advance through or
  // highlight.
  dashPrefix: string | null;
  currentWordIdx: number | null;
  currentSyllableIdx: number | null;
  tiers: { word: boolean; syllable: boolean };
  variant: "simplified" | "original";
  tintCurrent: boolean;
  gridColumn: number;
  gridRow: number;
}) {
  return (
    <div
      className={`simplify-focus__line simplify-focus__line--${variant}${tintCurrent ? " simplify-focus__line--current" : ""}`}
      style={{ gridColumn, gridRow }}
    >
      <div className="simplify-focus__line-inner">
        {dashPrefix && <span className="simplify-focus__dash-prefix">{dashPrefix} </span>}
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
