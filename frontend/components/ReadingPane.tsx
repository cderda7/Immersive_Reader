"use client";

import { useEffect, useMemo, useRef } from "react";
import { groupSyllables, type Syllable } from "@/lib/types";
import { SENTENCE_PAUSE_MS } from "@/lib/useReadingState";

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
  onWordClick: (paragraphIdx: number, wordIdx: number) => void;
  onSpace: () => void;
}

// How much opacity + transition speed a given word should have right now.
// During an ordinary sentence-pause fade, sentence1 (the one you're
// leaving) fades DOWN toward gray and sentence2 (pendingSentence, the one
// you're headed into) fades UP toward full focus, both timed to
// SENTENCE_PAUSE_MS -- so the fade completing is a true signal the pause
// window has elapsed, not a decorative animation with its own timing.
// Outside a sentence-pause, it's the simpler steady-state rule: current
// sentence full, everything else in the active paragraph dimmed, at the
// slower ambient speed.
function getWordFocus(args: {
  isActiveParagraph: boolean;
  paragraphIdx: number;
  wordSentenceIdx: number | undefined;
  currentSentenceIdx: number | undefined;
  isSentencePause: boolean;
  pendingSentence: PendingSentence | null;
}): { opacity: number; transitionMs: number } {
  const { isActiveParagraph, paragraphIdx, wordSentenceIdx, currentSentenceIdx, isSentencePause, pendingSentence } =
    args;

  if (!isActiveParagraph || wordSentenceIdx === undefined || currentSentenceIdx === undefined) {
    return { opacity: 1, transitionMs: AMBIENT_FADE_MS };
  }

  const isCurrentSentence = wordSentenceIdx === currentSentenceIdx;

  if (isSentencePause) {
    if (isCurrentSentence) return { opacity: 0.4, transitionMs: SENTENCE_PAUSE_MS }; // sentence1 -> gray
    const isPendingSentence =
      pendingSentence !== null &&
      paragraphIdx === pendingSentence.paragraphIdx &&
      wordSentenceIdx === pendingSentence.sentenceIdx;
    if (isPendingSentence) return { opacity: 1, transitionMs: SENTENCE_PAUSE_MS }; // sentence2 -> full focus
    return { opacity: 0.4, transitionMs: AMBIENT_FADE_MS }; // some other sentence, untouched by this pause
  }

  return isCurrentSentence
    ? { opacity: 1, transitionMs: AMBIENT_FADE_MS }
    : { opacity: 0.4, transitionMs: AMBIENT_FADE_MS };
}

export function ReadingPane({
  syllables,
  currentIndex,
  isParagraphPause,
  isSentencePause,
  pendingSentence,
  returnMode,
  onWordClick,
  onSpace,
}: ReadingPaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLSpanElement>(null);
  const current = syllables[currentIndex];
  const grouped = useMemo(() => groupSyllables(syllables), [syllables]);

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [currentIndex]);

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
        if (e.code === "Space" && !returnMode) {
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
              const { opacity, transitionMs } = getWordFocus({
                isActiveParagraph,
                paragraphIdx,
                wordSentenceIdx,
                currentSentenceIdx: current?.sentence_idx,
                isSentencePause,
                pendingSentence,
              });

              return (
                <span
                  key={wordIdx}
                  className={`reading-word${isCurrentWord ? " reading-word--current" : ""}${
                    returnMode ? " reading-word--clickable" : ""
                  }`}
                  style={{ opacity, transition: `opacity ${transitionMs}ms ease-in-out` }}
                  onClick={() => onWordClick(paragraphIdx, wordIdx)}
                >
                  {sylList.map((syl, syllableIdx) => {
                    const isCurrentSyllable = isCurrentWord && current?.syllable_idx === syllableIdx;
                    return (
                      <span
                        key={syllableIdx}
                        ref={isCurrentSyllable ? currentRef : undefined}
                        className={`reading-syllable${
                          isCurrentSyllable ? " reading-syllable--current" : ""
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
