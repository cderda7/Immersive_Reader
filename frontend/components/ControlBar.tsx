import type { AdvanceMode } from "@/lib/useReadingState";

interface ControlBarProps {
  textSize: number;
  setTextSize: (v: number) => void;
  letterSpacing: number;
  setLetterSpacing: (v: number) => void;
  lineHeight: number;
  setLineHeight: (v: number) => void;
  returnMode: boolean;
  onToggleReturnMode: () => void;
  advanceMode: AdvanceMode;
  setAdvanceMode: (m: AdvanceMode) => void;
}

const TEXT_SIZE_RANGE = [12, 40] as const;
const LETTER_SPACING_RANGE = [0, 10] as const;
const LINE_HEIGHT_RANGE = [1.0, 3.0] as const;

// Coarsest to finest, matching useReadingState's AdvanceMode hierarchy
// and ReadingPane's tiersFor() -- shown left-to-right in that order so
// the segmented control itself reads as a little hierarchy diagram.
const ADVANCE_MODES: { value: AdvanceMode; label: string }[] = [
  { value: "paragraph", label: "Paragraph" },
  { value: "sentence", label: "Sentence" },
  { value: "word", label: "Word" },
  { value: "syllable", label: "Syllable" },
];

export function ControlBar({
  textSize,
  setTextSize,
  letterSpacing,
  setLetterSpacing,
  lineHeight,
  setLineHeight,
  returnMode,
  onToggleReturnMode,
  advanceMode,
  setAdvanceMode,
}: ControlBarProps) {
  return (
    <div className="control-bar">
      <div className="control-group-row">
        <StepperGroup
          label="Text size"
          value={textSize}
          display={String(textSize)}
          onDown={() => setTextSize(Math.max(TEXT_SIZE_RANGE[0], textSize - 2))}
          onUp={() => setTextSize(Math.min(TEXT_SIZE_RANGE[1], textSize + 2))}
          downLabel="A-"
          upLabel="A+"
        />
        <StepperGroup
          label="Spacing ↔"
          value={letterSpacing}
          display={String(letterSpacing)}
          onDown={() => setLetterSpacing(Math.max(LETTER_SPACING_RANGE[0], letterSpacing - 1))}
          onUp={() => setLetterSpacing(Math.min(LETTER_SPACING_RANGE[1], letterSpacing + 1))}
        />
        <StepperGroup
          label="Spacing ↕"
          value={lineHeight}
          display={lineHeight.toFixed(1)}
          onDown={() => setLineHeight(Math.max(LINE_HEIGHT_RANGE[0], round1(lineHeight - 0.2)))}
          onUp={() => setLineHeight(Math.min(LINE_HEIGHT_RANGE[1], round1(lineHeight + 0.2)))}
        />
        <div className="advance-mode-group" role="radiogroup" aria-label="Advance by">
          <span className="control-label">Advance by</span>
          {ADVANCE_MODES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={advanceMode === value}
              className={`advance-mode-btn${advanceMode === value ? " advance-mode-btn--active" : ""}`}
              onClick={() => setAdvanceMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className={`return-btn${returnMode ? " return-btn--active" : ""}`}
          onClick={onToggleReturnMode}
        >
          {returnMode ? "Return to… (active)" : "Return to…"}
        </button>
      </div>
    </div>
  );
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function StepperGroup({
  label,
  display,
  onDown,
  onUp,
  downLabel = "−",
  upLabel = "+",
}: {
  label: string;
  value: number;
  display: string;
  onDown: () => void;
  onUp: () => void;
  downLabel?: string;
  upLabel?: string;
}) {
  return (
    <div className="control-group">
      <span className="control-label">{label}</span>
      <button className="ctrl-btn" aria-label={`Decrease ${label}`} onClick={onDown}>
        {downLabel}
      </button>
      <span className="ctrl-value">{display}</span>
      <button className="ctrl-btn" aria-label={`Increase ${label}`} onClick={onUp}>
        {upLabel}
      </button>
    </div>
  );
}
