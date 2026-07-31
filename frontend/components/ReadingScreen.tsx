"use client";

import { useEffect } from "react";
import { useReadingState, type AdvanceMode } from "@/lib/useReadingState";
import { useTapWord } from "@/lib/useTapWord";
import { ReadingPane } from "./ReadingPane";
import { ReturnBanner } from "./ReturnBanner";
import { ControlBar } from "./ControlBar";
import { LibraryPicker } from "./LibraryPicker";
import { PassageLoader } from "./PassageLoader";
import { BreathBanner } from "./BreathBanner";
import { WordInfoPopover } from "./WordInfoPopover";

// Singular noun for the hint line's "advance one ___ at a time" --
// mirrors ControlBar.tsx's ADVANCE_MODES labels, just lowercase/singular
// for reading naturally mid-sentence there.
const ADVANCE_MODE_LABEL: Record<AdvanceMode, string> = {
  syllable: "syllable",
  word: "word",
  sentence: "sentence",
  paragraph: "paragraph",
};

export function ReadingScreen() {
  const state = useReadingState();
  const tapWord = useTapWord();

  // Drive the CSS variables the typography controls target, so the whole
  // layout scales from one source of truth instead of per-element styles.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--reading-font-size", `${state.textSize}px`);
    root.style.setProperty("--reading-letter-spacing", `${state.letterSpacing}px`);
    root.style.setProperty("--reading-line-height", String(state.lineHeight));
  }, [state.textSize, state.letterSpacing, state.lineHeight]);

  return (
    <div className="app-frame">
      <header className="app-header">
        <h1>Immersive Reader — passage view</h1>
        <div className="legend">
          <LegendItem swatchClass="swatch--paragraph" label="paragraph" />
          <LegendItem swatchClass="swatch--word" label="word" />
          <LegendItem swatchClass="swatch--syllable" label="syllable" />
        </div>
      </header>

      <ReturnBanner
        active={state.returnMode}
        msLeft={state.returnMsLeft}
        totalMs={state.returnModeMs}
      />

      <LibraryPicker
        onLoadChapter={state.loadChapter}
        isLoading={state.isLoading}
        loadError={state.loadError}
      />

      <div className="reading-pane-wrap">
        <ReadingPane
          syllables={state.syllables}
          currentIndex={state.currentIndex}
          isParagraphPause={state.isParagraphPause}
          isSentencePause={state.isSentencePause}
          pendingSentence={state.pendingSentence}
          returnMode={state.returnMode}
          advanceMode={state.advanceMode}
          onWordClick={state.handleWordClick}
          onWordTap={tapWord.tapWord}
          tapWordOpen={tapWord.isOpen}
          onSpace={state.advance}
          onRetreat={state.retreat}
          wordDefineTrigger={state.wordDefineTrigger}
        />
        <BreathBanner active={state.isBreathError} />
        {tapWord.activeWord && (
          <WordInfoPopover
            activeWord={tapWord.activeWord}
            stage={tapWord.stage}
            wordInfo={tapWord.wordInfo}
            isLoading={tapWord.isLoading}
            error={tapWord.error}
            exampleError={tapWord.exampleError}
            onClose={tapWord.closeWord}
            onAdvance={tapWord.advanceStage}
            onReplayAudio={tapWord.replayAudio}
          />
        )}
      </div>

      <div className="passage-loader-wrap">
        <PassageLoader
          onLoad={state.loadPassage}
          isLoading={state.isLoading}
          loadError={state.loadError}
        />
      </div>

      <ControlBar
        textSize={state.textSize}
        setTextSize={state.setTextSize}
        letterSpacing={state.letterSpacing}
        setLetterSpacing={state.setLetterSpacing}
        lineHeight={state.lineHeight}
        setLineHeight={state.setLineHeight}
        returnMode={state.returnMode}
        advanceMode={state.advanceMode}
        setAdvanceMode={state.setAdvanceMode}
        onToggleReturnMode={() => {
          // Return-to mode repurposes word clicks for jump-to-word --
          // close any open tap-word card first so the two don't overlap.
          tapWord.closeWord();
          state.returnMode ? state.exitReturnMode() : state.enterReturnMode();
        }}
      />

      <p className="hint" aria-live="polite">
        {state.isParagraphPause ? (
          "Pausing before the next paragraph…"
        ) : (
          <>
            Click the passage, then press <kbd>Space</kbd> or <kbd>→</kbd> to advance, or{" "}
            <kbd>←</kbd> to go back, one {ADVANCE_MODE_LABEL[state.advanceMode]} at a time.
            {!state.returnMode && " Tap any word to look it up."}
          </>
        )}
      </p>
    </div>
  );
}

function LegendItem({ swatchClass, label }: { swatchClass: string; label: string }) {
  return (
    <span className="legend-item">
      <span className={`swatch ${swatchClass}`} />
      {label}
    </span>
  );
}
