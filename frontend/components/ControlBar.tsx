import type { AdvanceMode } from "@/lib/useReadingState";

interface ControlBarProps {
  textSize: number;
  setTextSize: (v: number) => void;
  letterSpacing: number;
  setLetterSpacing: (v: number) => void;
  lineHeight: number;
  setLineHeight: (v: number) => void;
  advanceMode: AdvanceMode;
  setAdvanceMode: (m: AdvanceMode) => void;
}

const TEXT_SIZE_RANGE = [12, 40] as const;
const LETTER_SPACING_RANGE = [0, 10] as const;
const LINE_HEIGHT_RANGE = [1.0, 3.0] as const;

// Finest to coarsest, per explicit product direction -- shown
// left-to-right in that order. Labels are lowercase on purpose (the
// "ADVANCE BY" group label above them carries the emphasis instead).
const ADVANCE_MODES: { value: AdvanceMode; label: string }[] = [
  { value: "syllable", label: "syllable" },
  { value: "word", label: "word" },
  { value: "sentence", label: "sentence" },
  { value: "paragraph", label: "paragraph" },
];

export function ControlBar({
  textSize,
  setTextSize,
  letterSpacing,
  setLetterSpacing,
  lineHeight,
  setLineHeight,
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
          <span className="control-label">ADVANCE BY</span>
          {ADVANCE_MODES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={advanceMode === value}
              className={`advance-mode-btn${advanceMode === value ? " advance-mode-btn--active" : ""}`}
              // Suppress the browser's default "focus this element on
              // click" behavior. Without this, clicking a mode button
              // (e.g. switching syllable -> word) leaves DOM keyboard
              // focus sitting ON THAT BUTTON -- unlike JUMP HERE
              // (ReadingPane.tsx), this button doesn't unmount afterward,
              // so focus doesn't even get stranded on <body>, it just
              // stays right here. .reading-pane's own Space-advances
              // handler only fires while IT holds focus; with focus on
              // this button instead, the very next Space press just
              // re-activates THIS button natively (a harmless no-op re-
              // click, since it's already the active mode) instead of
              // ever reaching the reading pane at all. Same fix, same
              // reasoning, as ReadingPane.tsx's JUMP HERE/SIMPLIFY
              // SENTENCE buttons.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setAdvanceMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
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
      {/* onMouseDown preventDefault on both buttons below -- same
          focus-stealing fix as the ADVANCE BY buttons above (see that
          comment for the full reasoning): without it, clicking A-/A+ or
          a spacing stepper leaves Space presses hitting this button
          instead of the reading pane's advance handler. */}
      <button
        className="ctrl-btn"
        aria-label={`Decrease ${label}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onDown}
      >
        {downLabel}
      </button>
      <span className="ctrl-value">{display}</span>
      <button
        className="ctrl-btn"
        aria-label={`Increase ${label}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onUp}
      >
        {upLabel}
      </button>
    </div>
  );
}
