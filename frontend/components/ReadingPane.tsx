"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { groupSyllables, type Syllable } from "@/lib/types";
import { SENTENCE_PAUSE_MS, type AdvanceMode } from "@/lib/useReadingState";

// Ambient fade speed for ordinary sentence-to-sentence focus shifts (i.e.
// NOT the deliberate pause below) -- slow and continuous, meant to read as
// eye movement rather than a discrete state change. Deliberately much
// slower than SENTENCE_PAUSE_MS.
const AMBIENT_FADE_MS = 700;

// How long Space/ArrowRight must be held before it opens tap-to-define for
// the word currently being read, instead of advancing. A genuine tap --
// press and release -- is comfortably under this on any normal keyboard,
// so the two gestures don't compete: onKeyDown starts this timer instead
// of advancing immediately, and onKeyUp either cancels it (fast release --
// treat as a normal advance) or, if the timer already fired, treats the
// release as consuming that hold instead of triggering a second action.
// Self-timed rather than keyed off the OS's key-repeat rate (which varies
// by system and is usually much slower than this anyway) -- see the
// e.repeat guard in onKeyDown below.
const HOLD_TO_DEFINE_MS = 200;

interface PendingSentence {
  paragraphIdx: number;
  sentenceIdx: number;
}

interface ReadingPaneProps {
  syllables: Syllable[];
  currentIndex: number;
  isParagraphPause: boolean;
  isSentencePause: boolean;
  pendingSentence: PendingSentence | null;
  advanceMode: AdvanceMode;
  // Jumps reading position straight to a word -- triggered by clicking the
  // hover-triggered "JUMP HERE" chip (see the per-word wrapper below), not
  // by any longer-lived mode toggle. Replaces the old dedicated
  // "Return to…" mode (click any word to jump, entered/exited via
  // ControlBar) with an inline affordance that appears right where the
  // student is already looking.
  onJumpToWord: (paragraphIdx: number, wordIdx: number) => void;
  onWordTap: (
    paragraphIdx: number,
    wordIdx: number,
    sentenceIdx: number,
    wordText: string,
    sentenceText: string
  ) => void;
  tapWordOpen: boolean;
  onSpace: () => void;
  onRetreat: () => void;
  // Shared with WordInfoPopover -- see the comment where ReadingScreen
  // creates this. Tracks physical down-state for Space/ArrowRight across
  // the handoff between this component's hold-to-define timer and that
  // one's advance-on-keypress guard.
  heldKeysRef: RefObject<Set<string>>;
}

// Reconstructs a sentence's plain text from the (paragraph, sentence)-
// grouped syllable data, for sending as context to /api/word-info.
// Syllables within a word concatenate directly (breaks are typographic,
// not word boundaries); words join with a single space. Punctuation
// already rides along on the first/last syllable of its word (see
// backend/syllabify.py), so this round-trips close to the original text.
function getSentenceText(words: Syllable[][], sentenceIdx: number): string {
  return words
    .filter((sylList) => sylList[0]?.sentence_idx === sentenceIdx)
    .map((sylList) => sylList.map((s) => s.text).join(""))
    .join(" ");
}

// Groups a paragraph's words into contiguous runs sharing one sentence_idx,
// so the render loop below can wrap each run in a single ancestor span
// (see SentenceRun/.reading-sentence) instead of coloring/backgrounding
// every word individually. That's what makes Sentence mode's highlight
// read as one fluid region -- a shared ancestor's background paints
// continuously behind the transparent margin gaps between its word-span
// children, closing the "gap at every space" look that per-word
// backgrounds had.
interface SentenceRun {
  sentenceIdx: number | undefined;
  wordIndices: number[];
}

function buildSentenceRuns(words: Syllable[][]): SentenceRun[] {
  const runs: SentenceRun[] = [];
  words.forEach((sylList, wordIdx) => {
    const sentenceIdx = sylList[0]?.sentence_idx;
    const last = runs[runs.length - 1];
    if (last && last.sentenceIdx === sentenceIdx) {
      last.wordIndices.push(wordIdx);
    } else {
      runs.push({ sentenceIdx, wordIndices: [wordIdx] });
    }
  });
  return runs;
}

// Text color -- see globals.css's note by .reading-word. Word/Syllable
// mode's sentence tier still uses this (current sentence black, other
// sentences in the paragraph grey); Sentence mode does not -- see
// SentenceTierStyle below.
const COLOR_CURRENT = "var(--ink)";
const COLOR_DIMMED = "var(--muted)";

// Sentence mode's OWN tier uses a background tint instead of the
// black/grey text-color contrast Word/Syllable mode use -- specifically
// reusing --tier-word (the same color Word/Syllable mode paint the
// single current WORD with), just applied across every word in the
// current sentence instead of one word. Carson's ask: keep all text
// black in this mode, and carry the "where am I" signal on background
// color instead. Paragraph mode has no sentence-level indicator at all
// (that tier isn't active there -- see tiersFor).
const BG_NONE = "transparent";
const BG_SENTENCE_TINT = "var(--tier-word)";

type SentenceTierStyle = "off" | "colorContrast" | "backgroundTint";

// Which highlight tiers are active for a given advance mode, cumulative
// from paragraph (always on, gated separately below via
// .reading-paragraph--current, unconditional) down through the mode's
// own granularity -- confirmed with Carson as "each gains one; so
// syllables have all of them; sentence has sentence + paragraph,
// paragraph only has paragraph." Word mode gets sentence + word (but not
// syllable); Sentence mode gets sentence only (but not word); Paragraph
// mode gets none of these three (paragraph tint alone). Sentence mode's
// own tier renders differently from Word/Syllable mode's -- see
// SentenceTierStyle above -- since Word/Syllable mode already spends the
// tint-background channel on the literal current word/syllable, while
// Sentence mode has that channel free to use for the sentence itself.
function tiersFor(mode: AdvanceMode): { sentenceStyle: SentenceTierStyle; word: boolean; syllable: boolean } {
  return {
    sentenceStyle: mode === "paragraph" ? "off" : mode === "sentence" ? "backgroundTint" : "colorContrast",
    word: mode === "word" || mode === "syllable",
    syllable: mode === "syllable",
  };
}

function getWordFocus(args: {
  isActiveParagraph: boolean;
  paragraphIdx: number;
  wordSentenceIdx: number | undefined;
  currentSentenceIdx: number | undefined;
  isSentencePause: boolean;
  pendingSentence: PendingSentence | null;
  sentenceStyle: SentenceTierStyle;
}): { color: string; background: string | undefined; transitionMs: number } {
  const {
    isActiveParagraph,
    paragraphIdx,
    wordSentenceIdx,
    currentSentenceIdx,
    isSentencePause,
    pendingSentence,
    sentenceStyle,
  } = args;

  // Paragraph mode: no finer distinction than "in the active paragraph
  // or not" is drawn -- every word there reads as fully current (black),
  // never dimmed, and never tinted -- there's no sentence-level tier to
  // contrast against. `background: undefined` here (and everywhere else
  // outside the backgroundTint branch below) means "don't set an inline
  // background at all" -- React omits the style property entirely,
  // leaving .reading-word--current's own CSS-class background (Word/
  // Syllable mode's current-word tint) free to show through undisturbed.
  if (sentenceStyle === "off") {
    return { color: COLOR_CURRENT, background: undefined, transitionMs: AMBIENT_FADE_MS };
  }

  if (!isActiveParagraph || wordSentenceIdx === undefined || currentSentenceIdx === undefined) {
    return { color: COLOR_CURRENT, background: undefined, transitionMs: AMBIENT_FADE_MS };
  }

  const isCurrentSentence = wordSentenceIdx === currentSentenceIdx;
  const isPendingSentence =
    pendingSentence !== null &&
    paragraphIdx === pendingSentence.paragraphIdx &&
    wordSentenceIdx === pendingSentence.sentenceIdx;

  if (sentenceStyle === "backgroundTint") {
    // Text never changes here -- always black, per Carson's ask -- only
    // the background carries the "which sentence" signal. Explicitly set
    // to BG_NONE (not undefined) even when untinted, so the tint/no-tint
    // states are both real CSS values the browser can transition
    // between -- toggling to/from `undefined` (no inline style at all)
    // wouldn't animate smoothly the way two concrete colors do.
    if (isSentencePause) {
      if (isCurrentSentence) return { color: COLOR_CURRENT, background: BG_NONE, transitionMs: SENTENCE_PAUSE_MS }; // tint fades OUT
      if (isPendingSentence)
        return { color: COLOR_CURRENT, background: BG_SENTENCE_TINT, transitionMs: SENTENCE_PAUSE_MS }; // tint fades IN
      return { color: COLOR_CURRENT, background: BG_NONE, transitionMs: AMBIENT_FADE_MS };
    }
    return {
      color: COLOR_CURRENT,
      background: isCurrentSentence ? BG_SENTENCE_TINT : BG_NONE,
      transitionMs: AMBIENT_FADE_MS,
    };
  }

  // colorContrast (Word/Syllable mode) -- unchanged from before, black/
  // grey text only, no background of its own (the current word's own
  // tint, via .reading-word--current, handles that tier instead).
  if (isSentencePause) {
    if (isCurrentSentence) return { color: COLOR_DIMMED, background: undefined, transitionMs: SENTENCE_PAUSE_MS }; // sentence1 -> grey
    if (isPendingSentence) return { color: COLOR_CURRENT, background: undefined, transitionMs: SENTENCE_PAUSE_MS }; // sentence2 -> black
    return { color: COLOR_DIMMED, background: undefined, transitionMs: AMBIENT_FADE_MS }; // some other sentence, untouched by this pause
  }

  return isCurrentSentence
    ? { color: COLOR_CURRENT, background: undefined, transitionMs: AMBIENT_FADE_MS }
    : { color: COLOR_DIMMED, background: undefined, transitionMs: AMBIENT_FADE_MS };
}

export function ReadingPane({
  syllables,
  currentIndex,
  isParagraphPause,
  isSentencePause,
  pendingSentence,
  advanceMode,
  onJumpToWord,
  onWordTap,
  tapWordOpen,
  onSpace,
  onRetreat,
  heldKeysRef,
}: ReadingPaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLSpanElement>(null);
  const current = syllables[currentIndex];
  const grouped = useMemo(() => groupSyllables(syllables), [syllables]);
  const tiers = useMemo(() => tiersFor(advanceMode), [advanceMode]);

  // Which word's "JUMP HERE" chip is currently showing, keyed as
  // "paragraphIdx-wordIdx". Set by mouseenter on either the word itself OR
  // the chip below it (both live inside the same .reading-word-wrap, see
  // the per-word render below) -- and cleared by mouseleave on that same
  // wrapper, which only actually fires once the pointer leaves BOTH,
  // since mouseenter/mouseleave are scoped to a DOM subtree, not a
  // rectangular hit region. The chip is rendered with zero gap directly
  // under the word (see .jump-here-btn's `top: 100%`) specifically so
  // there's no dead pixel strip between them for the pointer to slip
  // through on the way down -- that's what makes moving straight from the
  // word onto the chip read as one continuous hover instead of a
  // flicker-close.
  const [hoveredWordKey, setHoveredWordKey] = useState<string | null>(null);

  // Set right after a JUMP HERE click, briefly. Clicking removes the chip
  // (see below), which un-covers whatever text was sitting directly
  // beneath it -- almost always the next line down, since the chip
  // overlaps into it by design (zero-gap, see .jump-here-btn). Chrome
  // recomputes :hover for whatever's now topmost under a STATIONARY
  // cursor the instant that happens, without any real mouse movement, so
  // without this guard a fresh mouseenter fires for that newly-exposed
  // word immediately -- reading as "clicking JUMP HERE just opened
  // another JUMP HERE, right where I clicked." This window only needs to
  // outlast that one synthetic re-hover; genuine mouse movement after it
  // works normally again.
  const suppressHoverRef = useRef(false);
  const suppressHoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (suppressHoverTimeoutRef.current) clearTimeout(suppressHoverTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [currentIndex]);

  // Tracks the in-flight hold-to-define timer (see HOLD_TO_DEFINE_MS
  // above) and whether the current press has already been consumed by a
  // fired hold, so the matching keyup knows not to also treat it as a tap.
  const holdTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdConsumedRef = useRef(false);

  // Opens tap-to-define for whichever word is currently being read,
  // resolved the exact same way a real click on that word span would --
  // same wordText/sentenceText reconstruction, just driven by the hold
  // timer instead of a mouse event. Reads `current`/`grouped` from this
  // render's closure, which is accurate for the whole hold window since
  // nothing moves currentIndex while Space/ArrowRight is being held down.
  function openDefinitionForCurrentWord() {
    if (!current) return;
    const words = grouped[current.paragraph_idx];
    if (!words) return;
    const sylList = words[current.word_idx];
    if (!sylList) return;

    const wordText = sylList.map((s) => s.text).join("");
    const sentenceText = getSentenceText(words, current.sentence_idx);
    onWordTap(current.paragraph_idx, current.word_idx, current.sentence_idx, wordText, sentenceText);
  }

  // Clear any pending hold-to-define timer on unmount so it can't fire
  // (and call onWordTap) after the component's gone.
  useEffect(() => {
    return () => {
      if (holdTimeoutRef.current) {
        clearTimeout(holdTimeoutRef.current);
        holdTimeoutRef.current = null;
      }
    };
  }, []);

  // Auto-focus the pane on mount, AND every time a new passage/chapter
  // loads (syllables gets a new array reference from
  // useReadingState.ts's loadChapter/loadPassage). Without this, keyboard
  // focus defaults to <body> on first load, or stays on whatever picked
  // the chapter (LibraryPicker's <select>) on every load after that --
  // either way the onKeyDown handler below (which only fires on THIS
  // element) never sees the keypress, so Space/ArrowRight get silently
  // swallowed (a native <select> treats them as "reopen/change
  // selection", not "advance reading") until the student clicks into the
  // passage once. That first required click-to-escape-the-dropdown is
  // what reads as the reading process not starting on its own.
  useEffect(() => {
    paneRef.current?.focus();
  }, [syllables]);

  return (
    <div
      ref={paneRef}
      tabIndex={0}
      role="region"
      aria-label="Reading passage"
      className="reading-pane"
      style={{
        fontSize: "var(--reading-font-size)",
        letterSpacing: "var(--reading-letter-spacing)",
        lineHeight: "var(--reading-line-height)",
      }}
      onKeyDown={(e) => {
        // Space and ArrowRight both advance, but not immediately on
        // keydown -- see the hold-to-define comment above HOLD_TO_DEFINE_MS.
        // Instead this starts a timer; a quick release (onKeyUp below)
        // cancels it and performs the normal advance, while a sustained
        // hold lets the timer fire and open tap-to-define for the current
        // word instead, with zero movement. ArrowLeft retreats instead, on
        // keydown as before, via its own handler with none of advance()'s
        // pause/breath-error behavior -- see retreat()'s comment in
        // useReadingState.ts. Both always preventDefault() while the pane
        // is focused, even when tapWordOpen means nothing will actually
        // happen: only gating preventDefault() on that same condition is
        // exactly what let Space fall through to a real page-down scroll
        // while a card was open -- invisible on a short passage with
        // nothing to scroll, but very visible (and disorienting) on a tall
        // book chapter. Same risk applies to the arrow keys, so the same
        // rule.
        if (e.code === "Space" || e.code === "ArrowRight") {
          e.preventDefault();
          // Ignore the OS's key-repeat auto-fire entirely -- detection here
          // is self-timed off the genuine first keydown, not off however
          // fast/slow the OS decides to repeat. Without this, an auto-
          // repeat event mid-hold would restart the timer from zero and the
          // hold would never reach it.
          if (e.repeat) return;
          if (tapWordOpen) return;
          // Record physical down-state in the SHARED tracker (see
          // ReadingPane's heldKeysRef prop / ReadingScreen's comment) --
          // deliberately AFTER the tapWordOpen check above, not before
          // it. This handler still runs on every keydown regardless of
          // tapWordOpen (React's synthetic dispatch on this element fires
          // before the native event ever reaches WordInfoPopover's
          // document-level listener), so marking unconditionally here
          // would stamp "held" on every fresh press while a card is
          // already open too -- poisoning WordInfoPopover's own "is this
          // genuinely a new press" check a moment before it even runs,
          // making it think every press was already held and silently
          // swallowing all of them. Reached only when ReadingPane is
          // actually about to start ITS OWN hold timer below -- once
          // tapWordOpen is true, marking (and clearing) this ref for
          // these two keys is WordInfoPopover's job alone.
          heldKeysRef.current.add(e.code);
          holdConsumedRef.current = false;
          holdTimeoutRef.current = setTimeout(() => {
            holdTimeoutRef.current = null;
            holdConsumedRef.current = true;
            openDefinitionForCurrentWord();
          }, HOLD_TO_DEFINE_MS);
        } else if (e.code === "ArrowLeft") {
          e.preventDefault();
          if (!tapWordOpen) {
            onRetreat();
          }
        }
      }}
      onKeyUp={(e) => {
        if (e.code !== "Space" && e.code !== "ArrowRight") return;
        // Always clear the shared tracker on release, regardless of mode
        // -- this is the only place that does for the ordinary case
        // where tap-word never opens at all (ReadingPane owns the whole
        // press-release cycle by itself then), and it's harmless/
        // idempotent on the handoff case where WordInfoPopover's own
        // listener also clears the same entry for the same physical
        // keyup.
        heldKeysRef.current.delete(e.code);
        if (holdTimeoutRef.current) {
          // Released before the hold threshold -- a genuine tap. Cancel
          // the timer and perform the normal deferred advance.
          clearTimeout(holdTimeoutRef.current);
          holdTimeoutRef.current = null;
          if (!tapWordOpen) {
            onSpace();
          }
        } else if (holdConsumedRef.current) {
          // The hold already fired and opened the definition -- this
          // release just consumes that hold, no further action.
          holdConsumedRef.current = false;
        }
      }}
    >
      {grouped.map((words, paragraphIdx) => {
        // While isParagraphPause is true, currentIndex is still anchored on
        // the finishing paragraph's last syllable (so word/syllable
        // highlight holds steady), but no paragraph is marked "current" --
        // that's what lets .reading-paragraph--current's CSS transition
        // fade the old highlight out during the pause, ahead of the new
        // paragraph fading in once the pause resolves.
        const isCurrentParagraph = current?.paragraph_idx === paragraphIdx && !isParagraphPause;

        // Sentence-level focus is scoped to whichever paragraph you're
        // actually in -- deliberately NOT gated by isParagraphPause, so the
        // last sentence you were reading stays in focus through the
        // paragraph-transition pause rather than snapping dim early.
        const isActiveParagraph = current?.paragraph_idx === paragraphIdx;

        return (
          <p
            key={paragraphIdx}
            className={`reading-paragraph${isCurrentParagraph ? " reading-paragraph--current" : ""}`}
          >
            {buildSentenceRuns(words).map((run) => {
              // One getWordFocus call per sentence run, not per word --
              // its result is provably identical for every word sharing a
              // sentence_idx, since none of its inputs vary at sub-sentence
              // granularity. Color/background/transition all live on this
              // run's wrapper span now; individual word spans below no
              // longer set their own.
              const { color, background, transitionMs } = getWordFocus({
                isActiveParagraph,
                paragraphIdx,
                wordSentenceIdx: run.sentenceIdx,
                currentSentenceIdx: current?.sentence_idx,
                isSentencePause,
                pendingSentence,
                sentenceStyle: tiers.sentenceStyle,
              });

              return (
                <span
                  key={`sentence-${paragraphIdx}-${run.sentenceIdx ?? run.wordIndices[0]}`}
                  className={`reading-sentence${tiers.sentenceStyle === "backgroundTint" ? " reading-sentence--tint" : ""}`}
                  style={{
                    color,
                    backgroundColor: background,
                    transition: `color ${transitionMs}ms ease-in-out, background-color ${transitionMs}ms ease-in-out`,
                  }}
                >
                  {run.wordIndices.map((wordIdx) => {
                    const sylList = words[wordIdx];
                    const isCurrentWord = isCurrentParagraph && current?.word_idx === wordIdx;
                    const wordKey = `${paragraphIdx}-${wordIdx}`;
                    const isHovered = hoveredWordKey === wordKey;

                    // isCurrentWord/isCurrentSyllable are computed
                    // unconditionally regardless of which tiers are active
                    // -- scroll-into-view (via currentRef, below) should
                    // keep tracking the reading position in every mode.
                    // Only the *visual* tint classes are gated behind
                    // tiers.word/tiers.syllable.
                    return (
                      <span
                        key={wordIdx}
                        className="reading-word-wrap"
                        onMouseEnter={() => {
                          // Suppress while a tap-word card is open -- a
                          // JUMP HERE chip popping up under an unrelated
                          // word while the student is mid-lookup elsewhere
                          // would just be visual noise competing with it.
                          if (tapWordOpen) return;
                          // Suppress the synthetic re-hover that follows
                          // right on the heels of a JUMP HERE click -- see
                          // suppressHoverRef's comment above.
                          if (suppressHoverRef.current) return;
                          setHoveredWordKey(wordKey);
                        }}
                        onMouseLeave={() =>
                          setHoveredWordKey((cur) => (cur === wordKey ? null : cur))
                        }
                      >
                        <span
                          data-paragraph-idx={paragraphIdx}
                          data-word-idx={wordIdx}
                          data-sentence-idx={run.sentenceIdx}
                          className={`reading-word${isCurrentWord && tiers.word ? " reading-word--current" : ""} reading-word--tappable${
                            isHovered ? " reading-word--hover" : ""
                          }`}
                          onClick={() => {
                            if (run.sentenceIdx !== undefined) {
                              const wordText = sylList.map((s) => s.text).join("");
                              const sentenceText = getSentenceText(words, run.sentenceIdx);
                              onWordTap(paragraphIdx, wordIdx, run.sentenceIdx, wordText, sentenceText);
                            }
                          }}
                        >
                          {sylList.map((syl, syllableIdx) => {
                            const isCurrentSyllable = isCurrentWord && current?.syllable_idx === syllableIdx;
                            return (
                              <span
                                key={syllableIdx}
                                ref={isCurrentSyllable ? currentRef : undefined}
                                className={`reading-syllable${
                                  isCurrentSyllable && tiers.syllable ? " reading-syllable--current" : ""
                                }`}
                              >
                                {syl.text}
                              </span>
                            );
                          })}
                        </span>
                        {isHovered && (
                          <button
                            type="button"
                            className="jump-here-btn"
                            // Both the word span above and this chip live
                            // inside the same .reading-word-wrap, so a
                            // click here never also bubbles into a
                            // DIFFERENT word's onClick -- no
                            // stopPropagation needed for correctness, just
                            // clearing the hover state so the chip doesn't
                            // linger, visually stale, over the word's new
                            // reading position after the jump. Also arms
                            // suppressHoverRef briefly -- see its comment
                            // above -- so removing this button doesn't
                            // immediately re-trigger a hover for whatever
                            // text it was overlapping.
                            onClick={() => {
                              setHoveredWordKey(null);
                              suppressHoverRef.current = true;
                              if (suppressHoverTimeoutRef.current) {
                                clearTimeout(suppressHoverTimeoutRef.current);
                              }
                              suppressHoverTimeoutRef.current = setTimeout(() => {
                                suppressHoverRef.current = false;
                                suppressHoverTimeoutRef.current = null;
                              }, 250);
                              onJumpToWord(paragraphIdx, wordIdx);
                            }}
                          >
                            JUMP HERE
                          </button>
                        )}
                      </span>
                    );
                  })}
                </span>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}
