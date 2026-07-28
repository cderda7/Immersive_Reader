"use client";

import { useEffect } from "react";
import { useReadingState } from "@/lib/useReadingState";
import { ReadingPane } from "./ReadingPane";
import { ReturnBanner } from "./ReturnBanner";
import { ControlBar } from "./ControlBar";
import { PassageLoader } from "./PassageLoader";

export function ReadingScreen() {
  const state = useReadingState();

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

      <ReadingPane
        syllables={state.syllables}
        currentIndex={state.currentIndex}
        isParagraphPause={state.isParagraphPause}
        returnMode={state.returnMode}
        onWordClick={state.handleWordClick}
        onSpace={state.advance}
      />

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
        onToggleReturnMode={() =>
          state.returnMode ? state.exitReturnMode() : state.enterReturnMode()
        }
      />

      <p className="hint" aria-live="polite">
        {state.isParagraphPause ? (
          "Pausing before the next paragraph…"
        ) : (
          <>
            Click the passage, then press <kbd>Space</kbd> to advance one syllable at a time.
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
