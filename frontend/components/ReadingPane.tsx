"use client";

import { useEffect, useMemo, useRef } from "react";
import { groupSyllables, type Syllable } from "@/lib/types";
import { SENTENCE_PAUSE_MS, type AdvanceMode } from "@/lib/useReadingState";

// Ambient fade speed for ordinary sentence-to-sentence focus shifts (i.e.
// NOT the deliberate pause below) -- slow and continuous, meant to read as
// eye movement rather than a discrete state change. Deliberately much
// slower than SENTENCE_PAUSE_MS.
const AMBIENT_FADE_MS = 700;

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
  returnMode: boolean;
  advanceMode: AdvanceMode;
  onWordClick: (paragraphIdx: number, wordIdx: number) => void;
  onWordTap: (
    paragraphIdx: number,
    wordIdx: number,
    sentenceIdx: number,
    wordText: string,
    sentenceText: string
  ) => void;
  tapWordOpen: boolean;
  onSpace: () => void;
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
  returnMode,
  advanceMode,
  onWordClick,
  onWordTap,
  tapWordOpen,
  onSpace,
}: ReadingPaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLSpanElement>(null);
  const current = syllables[currentIndex];
  const grouped = useMemo(() => groupSyllables(syllables), [syllables]);
  const tiers = useMemo(() => tiersFor(advanceMode), [advanceMode]);

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [currentIndex]);

  // Auto-focus the pane on mount so Space advances immediately after a
  // page load/refresh. Without this, keyboard focus defaults to <body>,
  // and the onKeyDown handler below (which only fires on this element)
  // never sees the keypress -- Space is silently swallowed (or just
  // scrolls the page) until the student clicks into the passage once.
  // That first required click is what reads as a startup "lag."
  useEffect(() => {
    paneRef.current?.focus();
  }, []);

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
        if (e.code === "Space" && !returnMode && !tapWordOpen) {
          e.preventDefault();
          onSpace();
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
            {words.map((sylList, wordIdx) => {
              const isCurrentWord = isCurrentParagraph && current?.word_idx === wordIdx;

              // All syllables in a word share one sentence_idx -- read it
              // off the first.
              const wordSentenceIdx = sylList[0]?.sentence_idx;
              const { color, background, transitionMs } = getWordFocus({
                isActiveParagraph,
                paragraphIdx,
                wordSentenceIdx,
                currentSentenceIdx: current?.sentence_idx,
                isSentencePause,
                pendingSentence,
                sentenceStyle: tiers.sentenceStyle,
              });

              // isCurrentWord/isCurrentSyllable are computed unconditionally
              // regardless of which tiers are active -- scroll-into-view
              // (via currentRef, below) should keep tracking the reading
              // position in every mode. Only the *visual* tint classes are
              // gated behind tiers.word/tiers.syllable.
              return (
                <span
                  key={wordIdx}
                  data-paragraph-idx={paragraphIdx}
                  data-word-idx={wordIdx}
                  data-sentence-idx={wordSentenceIdx}
                  className={`reading-word${isCurrentWord && tiers.word ? " reading-word--current" : ""}${
                    returnMode ? " reading-word--clickable" : " reading-word--tappable"
                  }`}
                  style={{
                    color,
                    backgroundColor: background,
                    transition: `color ${transitionMs}ms ease-in-out, background-color ${transitionMs}ms ease-in-out`,
                  }}
                  onClick={() => {
                    if (returnMode) {
                      onWordClick(paragraphIdx, wordIdx);
                    } else if (wordSentenceIdx !== undefined) {
                      const wordText = sylList.map((s) => s.text).join("");
                      const sentenceText = getSentenceText(words, wordSentenceIdx);
                      onWordTap(paragraphIdx, wordIdx, wordSentenceIdx, wordText, sentenceText);
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
              );
            })}
          </p>
        );
      })}
    </div>
  );
}
