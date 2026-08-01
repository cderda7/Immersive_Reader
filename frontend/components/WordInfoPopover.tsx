"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ActiveWord, SimplifiedSentence, TapWordStage } from "@/lib/useTapWord";
import type { WordInfo } from "@/lib/types";

interface WordInfoPopoverProps {
  activeWord: ActiveWord;
  stage: TapWordStage;
  wordInfo: WordInfo | null;
  isLoading: boolean;
  error: string | null;
  // Failure of just the background example-sentence fetch -- separate
  // from `error` above since it doesn't block stages 1-4 (see
  // useTapWord.ts). Only StageContent's "example" case reads this.
  exampleError: string | null;
  onClose: () => void;
  onAdvance: () => void;
  // ArrowLeft while the card is open -- steps back a stage, or closes the
  // card if already on the first one (pronunciation). See
  // useTapWord.ts's retreatStage.
  onRetreat: () => void;
  onReplayAudio: () => void;
  // "Simplify sentence" -- independent of the stage cycle above, see
  // useTapWord.ts's simplifySentence. Available the instant the card
  // opens, not gated behind wordInfo/isLoading/error the way the stage
  // content is, since it only needs activeWord.sentenceText.
  simplifiedSentence: SimplifiedSentence | null;
  isSimplifying: boolean;
  simplifyError: string | null;
  onSimplifySentence: () => void;
  // Surrounding context (see lib/types.ts's neighboringSentenceText) --
  // shown alongside the simplified comparison once it's requested, so a
  // student can place the simplified wording back into the flow of the
  // passage instead of judging it in isolation. null when the tapped
  // sentence is the very first/last one in the passage.
  prevSentenceText: string | null;
  nextSentenceText: string | null;
  // Shared with ReadingPane -- see ReadingScreen's comment where this is
  // created. NOT a local Set here on purpose: a fresh, empty Set at
  // mount time would have no way to know Space/ArrowRight was already
  // physically held from the SAME press that just opened this card via
  // ReadingPane's hold-to-define timer, and the next OS auto-repeat
  // event would then read as a genuine new press and skip straight past
  // pronunciation before the student's finger ever left the key.
  heldKeysRef: RefObject<Set<string>>;
}

const GAP_PX = 10;
const VIEWPORT_PADDING = 12;

// Looks up the tapped word's own span, plus every word span sharing its
// sentence (for the "clear the whole sentence, not just this word" rule).
// DOM order matches reading order, so the sentence's topmost point is
// just the first element in this NodeList -- no need to sort by word_idx.
function querySentenceWords(paragraphIdx: number, sentenceIdx: number): NodeListOf<Element> {
  return document.querySelectorAll(
    `[data-paragraph-idx="${paragraphIdx}"][data-sentence-idx="${sentenceIdx}"]`
  );
}

function queryWord(paragraphIdx: number, wordIdx: number): Element | null {
  return document.querySelector(`[data-paragraph-idx="${paragraphIdx}"][data-word-idx="${wordIdx}"]`);
}

export function WordInfoPopover({
  activeWord,
  stage,
  wordInfo,
  isLoading,
  error,
  exampleError,
  onClose,
  onAdvance,
  onRetreat,
  onReplayAudio,
  simplifiedSentence,
  isSimplifying,
  simplifyError,
  onSimplifySentence,
  prevSentenceText,
  nextSentenceText,
  heldKeysRef,
}: WordInfoPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{ bottom: number; left: number } | null>(null);

  // Simplify sentence lives in its OWN floating panel now, below the
  // tapped word/sentence, rather than as the last section of the same
  // card above it -- explicit product direction: the two are visually
  // distinct concerns (word-level pronunciation/definition/morphology
  // above; sentence-level simplification below), so they get opposite
  // sides of the reading position instead of competing for space in one
  // ever-taller box. Same "anchor the edge closest to the text, not the
  // far edge" trick as the word-info card below, just mirrored: this one
  // grows DOWNWARD from a fixed top, so it never has to re-measure or
  // move as its own content changes size (empty -> button -> loading ->
  // comparison -> comparison-with-context are all very different heights).
  const simplifyRef = useRef<HTMLDivElement>(null);
  const [simplifyStyle, setSimplifyStyle] = useState<{ top: number; left: number } | null>(null);

  // Horizontal centering + edge-clamping shared by both panels -- each
  // measures its OWN width (they're not the same width) but centers on
  // the same point, the tapped word, regardless of which panel it is.
  function clampedLeft(wordRect: DOMRect, panelWidth: number): number {
    let left = wordRect.left + wordRect.width / 2 - panelWidth / 2;
    const maxLeft = window.innerWidth - panelWidth - VIEWPORT_PADDING;
    return Math.min(Math.max(left, VIEWPORT_PADDING), Math.max(maxLeft, VIEWPORT_PADDING));
  }

  // Position once per tapped word, not per stage. Anchored by the box's
  // BOTTOM edge (a fixed gap above the sentence's top), not its top edge.
  // A top-based position has to know the box's own height up front to
  // compute where "top" should land -- and that height changes stage to
  // stage (pronunciation is short, a definition is taller, morphology
  // taller still), which is exactly what made the box visibly jump as
  // students clicked through: every stage change re-measured a different
  // height and recomputed a different top. Anchoring the bottom instead
  // means the box always grows upward from the same fixed point above the
  // sentence -- it never has to move to stay clear, and it can't overlap
  // the sentence regardless of how tall any given stage's content is.
  // Left is likewise stable across stages since the card's width is fixed
  // by CSS (only height varies by stage). Because of this, the effect
  // only needs to depend on activeWord -- re-tapping the SAME word to
  // advance a stage doesn't create a new activeWord object (see
  // useTapWord's tapWord/advanceStage), so this simply doesn't re-run
  // between stages, and the box stays put.
  // useLayoutEffect (not useEffect) so the initial position resolves
  // before paint -- no visible jump on first open either.
  useLayoutEffect(() => {
    const popoverEl = popoverRef.current;
    const wordEl = queryWord(activeWord.paragraphIdx, activeWord.wordIdx);
    const sentenceWords = querySentenceWords(activeWord.paragraphIdx, activeWord.sentenceIdx);
    if (!popoverEl || !wordEl || sentenceWords.length === 0) {
      setStyle(null);
      return;
    }

    const wordRect = wordEl.getBoundingClientRect();
    const sentenceTopRect = sentenceWords[0].getBoundingClientRect();
    const popoverRect = popoverEl.getBoundingClientRect();

    const bottom = window.innerHeight - sentenceTopRect.top + GAP_PX;
    const left = clampedLeft(wordRect, popoverRect.width);

    setStyle({ bottom, left });
  }, [activeWord]);

  // Mirrors the effect above: anchored by the TOP edge instead, a fixed
  // gap BELOW the sentence's bottom -- the sentence's LAST word (not the
  // tapped word, which may not be the sentence's last if it wraps across
  // lines) gives the true bottom-most point of the whole sentence, same
  // reasoning querySentenceWords' own comment gives for using [0] as the
  // topmost point above.
  useLayoutEffect(() => {
    const simplifyEl = simplifyRef.current;
    const wordEl = queryWord(activeWord.paragraphIdx, activeWord.wordIdx);
    const sentenceWords = querySentenceWords(activeWord.paragraphIdx, activeWord.sentenceIdx);
    if (!simplifyEl || !wordEl || sentenceWords.length === 0) {
      setSimplifyStyle(null);
      return;
    }

    const wordRect = wordEl.getBoundingClientRect();
    const sentenceBottomRect = sentenceWords[sentenceWords.length - 1].getBoundingClientRect();
    const simplifyRect = simplifyEl.getBoundingClientRect();

    const top = sentenceBottomRect.bottom + GAP_PX;
    const left = clampedLeft(wordRect, simplifyRect.width);

    setSimplifyStyle({ top, left });
  }, [activeWord]);

  // onAdvance gets a NEW identity on every stage advance -- advanceStage
  // closes over advanceOrRetry (useTapWord.ts), which itself depends on
  // stageIndex, so a fresh stageIndex means a fresh advanceOrRetry means
  // a fresh advanceStage/onAdvance, every single time. The keydown effect
  // below only depends on [activeWord, onClose], and activeWord
  // deliberately stays the SAME object across stage advances (see the
  // position effect's comment above -- that's what keeps the card from
  // jumping). So that effect never re-runs mid-word, meaning a closure
  // captured directly over `onAdvance` there would go stale after the
  // very first press: specifically, it'd keep computing "advance" against
  // whatever `stages` array existed the instant the word was tapped --
  // often just ["pronunciation"] alone, since wordInfo is still null at
  // that exact moment, before the fetch has resolved -- clamping every
  // later press right back to stage 0 forever, no matter how many times
  // it's pressed. A ref sidesteps that: always reads the CURRENT
  // onAdvance without needing to re-bind (and thereby re-run the
  // pointerdown/scroll listeners bundled in the same effect) on every
  // single stage change.
  const onAdvanceRef = useRef(onAdvance);
  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  // Same staleness problem, same fix, for ArrowLeft -- onRetreat
  // (useTapWord.ts's retreatStage) closes over stageIndex too, so it gets
  // a fresh identity every stage change just like onAdvance does.
  const onRetreatRef = useRef(onRetreat);
  useEffect(() => {
    onRetreatRef.current = onRetreat;
  }, [onRetreat]);

  // heldKeysRef comes in as a prop now (shared with ReadingPane) rather
  // than a local ref -- see this component's prop doc comment for why a
  // fresh local Set here specifically broke the hold-to-define handoff.
  // Tracks which of Space/ArrowRight are currently physically held down,
  // so a sustained hold can only ever trigger ONE advance -- the next one
  // requires a genuine keyup first, i.e. a real break between presses.
  // Relying on the browser's own e.repeat flag alone would probably have
  // covered the common case, but this is the more explicit, more
  // robust version of the same idea: it doesn't matter WHY a second
  // keydown arrived without a keyup in between (OS auto-repeat, or any
  // other double-fire) -- if this code is already marked held, it's
  // ignored outright.

  // Close on outside click/touch (anything that's not either panel --
  // word-info above OR simplify below, now two separate elements -- or
  // the tapped word's own span; re-tapping the same word is handled by
  // tapWord as a stage-advance, not a close) and on Escape.
  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      const wordEl = queryWord(activeWord.paragraphIdx, activeWord.wordIdx);
      if (popoverRef.current?.contains(target)) return;
      if (simplifyRef.current?.contains(target)) return;
      if (wordEl?.contains(target)) return;
      onClose();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Space/ArrowRight advance the card, mirroring the box's own
      // onClick={onAdvance} below (same retry-on-error behavior and
      // all -- see advanceOrRetry in useTapWord.ts). Safe to claim these
      // keys globally while a word is active: ReadingPane's own
      // Space/ArrowRight handling already no-ops whenever tapWordOpen is
      // true (see its onKeyDown), specifically so the two don't compete
      // for what these keys mean -- this is that other half.
      //
      // Skip it when focus is on an interactive element inside the card
      // (the "Hear it again" button) -- Space there already has its own
      // native meaning (activate the button), and this shouldn't hijack
      // that or fire alongside it as a second, unintended action.
      if (e.code === "Space" || e.code === "ArrowRight") {
        if (e.target instanceof HTMLElement && e.target.closest("button")) return;
        e.preventDefault();
        if (heldKeysRef.current.has(e.code)) return; // still down from a previous keydown -- wait for keyup
        heldKeysRef.current.add(e.code);
        onAdvanceRef.current();
      } else if (e.code === "ArrowLeft") {
        // ArrowLeft steps back a stage (or closes the card, on the first
        // one -- see retreatStage). ReadingPane's OWN ArrowLeft handling
        // (normal retreat() through the passage) already no-ops whenever
        // tapWordOpen is true, exactly mirroring how it steps aside for
        // Space/ArrowRight above -- same reasoning, this is that other
        // half for the third key. No heldKeysRef dedupe here: unlike
        // Space/ArrowRight there's no hold-to-define timer for this key
        // to hand off from, and ReadingPane's own retreat() has never
        // rate-limited ArrowLeft either -- holding it down is fine.
        if (e.target instanceof HTMLElement && e.target.closest("button")) return;
        e.preventDefault();
        onRetreatRef.current();
      }
    }
    function handleKeyUp(e: KeyboardEvent) {
      if (e.code === "Space" || e.code === "ArrowRight") {
        heldKeysRef.current.delete(e.code);
      }
    }
    // Closing on scroll rather than re-tracking position through it --
    // simplest way to avoid the card drifting stale relative to the text.
    function handleScroll() {
      onClose();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [activeWord, onClose]);

  return (
    <>
      <div
        ref={popoverRef}
        className="word-info-popover"
        role="dialog"
        aria-label={`Word info: ${activeWord.word}`}
        // Clicking the box itself advances the stage, same as tapping the
        // word -- the "Hear it again" button below stops this from firing
        // on top of its own click (see its onClick), so replaying audio
        // doesn't also skip a stage.
        onClick={onAdvance}
        style={{
          position: "fixed",
          bottom: style?.bottom ?? 0,
          left: style?.left ?? 0,
          visibility: style ? "visible" : "hidden",
          cursor: "pointer",
        }}
      >
        <div className="word-info-popover__header">{cleanHeaderWord(wordInfo, activeWord.word)}</div>
        <div className="word-info-popover__body">
          {isLoading && <span className="word-info-popover__muted">Looking it up…</span>}
          {error && !isLoading && (
            <span className="word-info-popover__error">
              {error} Tap the word again to retry.
            </span>
          )}
          {wordInfo && !isLoading && !error && (
            <StageContent stage={stage} wordInfo={wordInfo} exampleError={exampleError} onReplayAudio={onReplayAudio} />
          )}
        </div>
      </div>

      {/* Simplify sentence -- its own panel below the tapped word/sentence,
          not part of the word-info card above it. A separate, supplementary
          action on the whole SENTENCE, not the pronunciation/definition/
          morphology/hear-aloud/example flow above, which is scoped to just
          the tapped WORD -- so it gets its own space below reading
          position instead of competing with that content for room in one
          box. No onClick={onAdvance} here (unlike the card above): clicks
          in this panel are about simplifying, not the word-info stage
          cycle, so there's nothing for the button below to stopPropagation
          against anymore either. */}
      <div
        ref={simplifyRef}
        className="simplify-popover"
        role="region"
        aria-label={`Simplify sentence: ${activeWord.word}`}
        style={{
          position: "fixed",
          top: simplifyStyle?.top ?? 0,
          left: simplifyStyle?.left ?? 0,
          visibility: simplifyStyle ? "visible" : "hidden",
        }}
      >
        {!simplifiedSentence && (
          <button
            type="button"
            className="simplify-popover__btn"
            disabled={isSimplifying}
            onClick={onSimplifySentence}
          >
            {isSimplifying ? "Simplifying…" : "🪄 Simplify sentence"}
          </button>
        )}
        {simplifyError && !isSimplifying && <span className="word-info-popover__error">{simplifyError}</span>}
        {simplifiedSentence && !simplifiedSentence.needs_simplification && (
          <span className="word-info-popover__muted">No simplified sentence available.</span>
        )}
        {simplifiedSentence && simplifiedSentence.needs_simplification && (
          <>
            {/* Surrounding context, so the simplified wording isn't
                judged in isolation -- see this component's prop doc
                comment for prevSentenceText/nextSentenceText. */}
            {prevSentenceText && <div className="simplify-popover__context">{prevSentenceText}</div>}
            {/* Whole original directly above the whole simplified
                rewrite -- one coherent sentence each, not a chunk-by-
                chunk breakdown (see word_info.py's simplify_sentence
                docstring for why that changed). */}
            <div className="simplify-popover__compare">
              <div className="simplify-popover__compare-original">{activeWord.sentenceText}</div>
              <div className="simplify-popover__compare-simplified">{simplifiedSentence.simplified}</div>
            </div>
            {nextSentenceText && <div className="simplify-popover__context">{nextSentenceText}</div>}
          </>
        )}
      </div>
    </>
  );
}

function cleanHeaderWord(wordInfo: WordInfo | null, fallback: string): string {
  if (wordInfo) return wordInfo.word;
  return fallback.replace(/^[^\p{L}\p{N}'-]+|[^\p{L}\p{N}'-]+$/gu, "").toLowerCase();
}

function StageContent({
  stage,
  wordInfo,
  exampleError,
  onReplayAudio,
}: {
  stage: TapWordStage;
  wordInfo: WordInfo;
  exampleError: string | null;
  onReplayAudio: () => void;
}) {
  switch (stage) {
    case "pronunciation":
      return (
        <>
          {wordInfo.ipa && <div className="word-info-popover__ipa">{formatIpa(wordInfo.ipa)}</div>}
          {wordInfo.respelling && <div className="word-info-popover__respelling">{wordInfo.respelling}</div>}
        </>
      );
    case "definition":
      return <div>{wordInfo.definition}</div>;
    case "morphology":
      return wordInfo.morphology ? (
        <>
          <div className="word-info-popover__morphology-parts">{wordInfo.morphology.parts.join(" + ")}</div>
          <div className="word-info-popover__muted">{wordInfo.morphology.note}</div>
        </>
      ) : null;
    case "hearAloud":
      return (
        <button
          type="button"
          className="word-info-popover__replay-btn"
          onClick={(e) => {
            // Stop this from also bubbling up to the box's own
            // onClick={onAdvance} -- replaying audio shouldn't ALSO
            // skip ahead to the next stage.
            e.stopPropagation();
            onReplayAudio();
          }}
        >
          🔊 Hear it again
        </button>
      );
    case "example":
      // example_sentence starts as "" the instant pronunciation/
      // definition/morphology/hear-aloud are already showable -- see
      // word_info.py's get_word_info_quick -- and gets patched in
      // slightly later by the background /api/word-example call. "" here
      // means "still writing one", not "this word has no example"; by
      // the time a student reaches this last stage it has almost always
      // already arrived.
      if (wordInfo.example_sentence) {
        return <div className="word-info-popover__example">{wordInfo.example_sentence}</div>;
      }
      if (exampleError) {
        return (
          <span className="word-info-popover__error">
            {exampleError} Tap to try again.
          </span>
        );
      }
      return <span className="word-info-popover__muted">Writing an example…</span>;
    default:
      return null;
  }
}

// dictionaryapi.dev's phonetic strings already come wrapped in slashes
// (e.g. "/dʒʌmp/"); Claude's rare fallback-generated ones (see
// word_info.py's _generate_full_fallback_bundle) don't reliably include
// them. Normalizing here so the two sources render identically
// regardless of which one supplied this particular word's IPA.
function formatIpa(ipa: string): string {
  const trimmed = ipa.trim();
  return trimmed.startsWith("/") && trimmed.endsWith("/") ? trimmed : `/${trimmed}/`;
}
