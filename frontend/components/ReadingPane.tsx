"use client";

import { useEffect, useMemo, useRef } from "react";
import { groupSyllables, type Syllable } from "@/lib/types";

interface ReadingPaneProps {
  syllables: Syllable[];
  currentIndex: number;
  returnMode: boolean;
  onWordClick: (paragraphIdx: number, wordIdx: number) => void;
  onSpace: () => void;
}

export function ReadingPane({
  syllables,
  currentIndex,
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
        const isCurrentParagraph = current?.paragraph_idx === paragraphIdx;
        return (
          <p
            key={paragraphIdx}
            className={`reading-paragraph${isCurrentParagraph ? " reading-paragraph--current" : ""}`}
          >
            {words.map((sylList, wordIdx) => {
              const isCurrentWord = isCurrentParagraph && current?.word_idx === wordIdx;
              return (
                <span
                  key={wordIdx}
                  className={`reading-word${isCurrentWord ? " reading-word--current" : ""}${
                    returnMode ? " reading-word--clickable" : ""
                  }`}
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
