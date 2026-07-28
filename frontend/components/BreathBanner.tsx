"use client";

import { BREATH_ERROR_FADE_MS } from "@/lib/useReadingState";

interface BreathBannerProps {
  active: boolean;
}

// Calming interruption shown when a student presses space during a
// SENTENCE pause (see triggerBreathError in useReadingState.ts). A rushed
// press there means the student expects to already be on a new syllable --
// letting it through would desync the highlight from the sentence that's
// about to load, so this covers the passage instead: deep green
// background, the message in white, then a fade back out as the passage
// resets to the start of the interrupted paragraph. Always mounted (rather
// than conditionally rendered) so the opacity transition actually plays in
// both directions, matching the toggling-text-content pattern used for the
// paragraph-pause hint in ReadingScreen.tsx.
export function BreathBanner({ active }: BreathBannerProps) {
  return (
    <div
      className={`breath-overlay${active ? " breath-overlay--active" : ""}`}
      style={{ transition: `opacity ${BREATH_ERROR_FADE_MS}ms ease-in-out` }}
      aria-live="assertive"
      aria-hidden={!active}
    >
      {active ? "Take a breath between sentences." : ""}
    </div>
  );
}
