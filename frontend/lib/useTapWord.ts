"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { WordInfo } from "./types";

export type TapWordStage = "pronunciation" | "definition" | "morphology" | "hearAloud" | "example";

export interface ActiveWord {
  paragraphIdx: number;
  wordIdx: number;
  sentenceIdx: number;
  word: string; // raw as-clicked text, e.g. "hallucinate." with trailing punctuation
  sentenceText: string; // stashed so advanceStage/retry don't need it re-passed by the caller
}

// Strip surrounding punctuation and lowercase, e.g. '"Hallucinate,' ->
// "hallucinate" -- mirrors backend/word_info.py's clean_word so the cache
// key here matches what the backend treats as the same word, and so the
// card's header shows the same clean form regardless of where in a
// sentence the word was tapped from.
function cleanWordText(raw: string): string {
  return raw.replace(/^[^\p{L}\p{N}'-]+|[^\p{L}\p{N}'-]+$/gu, "").toLowerCase();
}

// Slightly slower than default (1.0) for clarity, matching this app's
// struggling-reader audience -- same reasoning as the deliberate pauses
// in useReadingState.ts, just applied to speech rate instead of timing.
const HEAR_ALOUD_RATE = 0.85;

function speak(word: string) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel(); // don't let utterances stack if tapped rapidly
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.rate = HEAR_ALOUD_RATE;
  window.speechSynthesis.speak(utterance);
}

function stagesFor(info: WordInfo | null): TapWordStage[] {
  // Before data has loaded, only the (loading-state) pronunciation stage
  // exists -- further taps on the same word are no-ops until it resolves,
  // see tapWord's stageIndex clamp below.
  if (!info) return ["pronunciation"];
  const stages: TapWordStage[] = ["pronunciation", "definition"];
  if (info.morphology) stages.push("morphology");
  stages.push("hearAloud", "example");
  return stages;
}

export function useTapWord() {
  const [activeWord, setActiveWord] = useState<ActiveWord | null>(null);
  const [stageIndex, setStageIndex] = useState(0);
  const [wordInfo, setWordInfo] = useState<WordInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cached across the whole session, keyed by cleaned word -- re-tapping
  // a word seen before (anywhere in the passage) doesn't refetch.
  const cacheRef = useRef<Map<string, WordInfo>>(new Map());

  // Bumped on every new-word tap; a fetch whose id no longer matches by
  // the time it resolves belongs to a word the student has since tapped
  // away from, so its result is ignored -- prevents a slow response for
  // word A clobbering word B's already-loaded state.
  const requestIdRef = useRef(0);

  const stages = useMemo(() => stagesFor(wordInfo), [wordInfo]);

  const fetchWordInfo = useCallback((cleanWord: string, sentence: string) => {
    const cached = cacheRef.current.get(cleanWord);
    if (cached) {
      setWordInfo(cached);
      setIsLoading(false);
      setError(null);
      return;
    }

    const requestId = ++requestIdRef.current;
    setWordInfo(null);
    setIsLoading(true);
    setError(null);

    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    fetch(`${apiUrl}/api/word-info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word: cleanWord, sentence }),
    })
      .then(async (res) => {
        if (!res.ok) {
          // The backend returns {"error": "..."} on failure (see
          // main.py's word_info_route) -- surface that real message
          // instead of just the status code when it's there.
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `Backend returned ${res.status}`);
        }
        return res.json();
      })
      .then((data: WordInfo) => {
        if (requestIdRef.current !== requestId) return; // stale, see above
        cacheRef.current.set(cleanWord, data);
        setWordInfo(data);
        setIsLoading(false);
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) return;
        setError(
          err instanceof Error
            ? `Couldn't look up "${cleanWord}" (${err.message}).`
            : `Couldn't look up "${cleanWord}".`
        );
        setIsLoading(false);
      });
  }, []);

  // Shared by tapWord (tapping the word again) and advanceStage (clicking
  // the box itself) -- both mean the same thing once a word is already
  // active: move to the next stage, or retry if the last fetch failed.
  const advanceOrRetry = useCallback(
    (rawWordText: string, sentenceText: string) => {
      // A prior fetch for this word failed -- advancing should retry
      // rather than silently no-op (stages would still just be
      // ["pronunciation"] with nothing to advance into).
      if (!wordInfo && !isLoading && error) {
        fetchWordInfo(cleanWordText(rawWordText), sentenceText);
        return;
      }
      setStageIndex((i) => {
        const next = Math.min(i + 1, stages.length - 1);
        if (stages[next] === "hearAloud" && next !== i) speak(wordInfo?.word ?? rawWordText);
        return next;
      });
    },
    [wordInfo, isLoading, error, stages, fetchWordInfo]
  );

  const tapWord = useCallback(
    (paragraphIdx: number, wordIdx: number, sentenceIdx: number, rawWordText: string, sentenceText: string) => {
      const isSameWord =
        activeWord !== null && activeWord.paragraphIdx === paragraphIdx && activeWord.wordIdx === wordIdx;

      if (isSameWord) {
        advanceOrRetry(rawWordText, sentenceText);
        return;
      }

      setActiveWord({ paragraphIdx, wordIdx, sentenceIdx, word: rawWordText, sentenceText });
      setStageIndex(0);
      fetchWordInfo(cleanWordText(rawWordText), sentenceText);
    },
    [activeWord, advanceOrRetry, fetchWordInfo]
  );

  // Clicking the box itself (WordInfoPopover's onAdvance) -- same
  // advance-or-retry behavior as tapping the word again, just sourced
  // from the already-active word instead of a fresh click's params.
  const advanceStage = useCallback(() => {
    if (!activeWord) return;
    advanceOrRetry(activeWord.word, activeWord.sentenceText);
  }, [activeWord, advanceOrRetry]);

  const closeWord = useCallback(() => {
    setActiveWord(null);
  }, []);

  const replayAudio = useCallback(() => {
    if (wordInfo) speak(wordInfo.word);
  }, [wordInfo]);

  return {
    activeWord,
    isOpen: activeWord !== null,
    stageIndex,
    stage: stages[stageIndex] ?? "pronunciation",
    stages,
    wordInfo,
    isLoading,
    error,
    tapWord,
    advanceStage,
    closeWord,
    replayAudio,
  };
}
