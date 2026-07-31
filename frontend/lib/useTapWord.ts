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

// Neither fetch had a timeout before -- a hung connection (server down
// mid-request, dropped wifi) would leave "Looking it up…" or "Writing an
// example…" showing forever with no way to recover short of tapping a
// different word and back. Bounding both means a stall always resolves
// into a real, retryable error within 15s instead of an indefinite hang.
const FETCH_TIMEOUT_MS = 15000;

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
  // morphology is decided synchronously as part of the FAST /api/word-info
  // response (dictionary + rules, no LLM -- see word_info.py's
  // analyze_morphology), never patched in later by the slow example
  // fetch below. That matters: it means this array's shape is fixed the
  // moment `info` first exists and never changes again for this word, so
  // a student who has already tapped past this point never sees the
  // stage list reshuffle out from under them.
  if (info.morphology) stages.push("morphology");
  stages.push("hearAloud", "example");
  return stages;
}

// Shape POST /api/word-example returns -- always respelling +
// example_sentence; ipa and/or definition only show up on the word(s)
// dictionaryapi.dev didn't have them for, which Claude had to invent --
// see word_info.py's get_word_example. Morphology never comes from this
// endpoint; it's decided entirely by the fast /api/word-info response.
interface WordExampleResponse {
  respelling: string;
  example_sentence: string;
  ipa?: string;
  definition?: string;
}

export function useTapWord() {
  const [activeWord, setActiveWord] = useState<ActiveWord | null>(null);
  const [stageIndex, setStageIndex] = useState(0);
  const [wordInfo, setWordInfo] = useState<WordInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error` above on purpose: `error` gates the WHOLE
  // card (pronunciation/definition/morphology/hear-aloud all depend on
  // the fast fetch succeeding). A failed example fetch shouldn't block
  // any of that -- only StageContent's "example" case reads this one.
  const [exampleError, setExampleError] = useState<string | null>(null);

  // Two caches, mirroring the backend's own quick/example split (see
  // word_info.py) rather than one all-or-nothing cache -- a word can
  // have its quick data cached while its example is still in flight (or
  // the reverse, if the student taps away and back mid-fetch), so they
  // need to be tracked independently. exampleCacheRef stores the WHOLE
  // response object, not just the sentence text -- it always carries
  // `respelling` too now (see word_info.py's module docstring for why
  // that moved off the fast/rule-based path), and losing it on a cache
  // hit would mean a re-tapped word's pronunciation stage permanently
  // shows no respelling even after it was already fetched once.
  //
  // Keyed by WORD + SENTENCE together (see cacheKey below), mirroring
  // word_info.py's _quick_cache/_example_cache split there -- which
  // definition fits (and the respelling/example generated alongside it)
  // is supposed to change with context, so caching by word alone would
  // silently keep showing the first sentence's answer if the same word
  // shows up again later in the passage in a different sense. A repeat
  // tap of the SAME word in the SAME sentence still hits cache exactly
  // as before.
  const quickCacheRef = useRef<Map<string, WordInfo>>(new Map());
  const exampleCacheRef = useRef<Map<string, WordExampleResponse>>(new Map());

  // Separator is a control character that would never appear in a
  // cleaned word or in real passage text, so there's no realistic
  // collision risk between e.g. word="a", sentence="bc" and word="ab",
  // sentence="c".
  function cacheKey(cleanWord: string, sentence: string): string {
    return `${cleanWord}${sentence}`;
  }

  // Bumped on every new-word tap; a fetch whose id no longer matches by
  // the time it resolves belongs to a word the student has since tapped
  // away from, so its result is ignored -- prevents a slow response for
  // word A clobbering word B's already-loaded state.
  const requestIdRef = useRef(0);

  const stages = useMemo(() => stagesFor(wordInfo), [wordInfo]);

  // Fetches JUST the quick data. Extracted so it can be called from
  // fetchWordInfo below without duplicating the timeout/error-shaping
  // logic. Always reads requestIdRef fresh at call time for its own
  // staleness check, rather than being passed a snapshot -- correct
  // whether it's called synchronously right after requestIdRef was
  // bumped (a new word) or later (there's currently no retry path for
  // just the quick fetch, but keeping this symmetric with
  // fetchExampleOnly below avoids a subtle bug if one gets added later).
  const fetchQuickOnly = useCallback((cleanWord: string, sentence: string) => {
    const requestId = requestIdRef.current;
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    fetch(`${apiUrl}/api/word-info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word: cleanWord, sentence }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `Backend returned ${res.status}`);
        }
        return res.json();
      })
      .then((data: WordInfo) => {
        if (requestIdRef.current !== requestId) return; // stale, see requestIdRef's comment
        quickCacheRef.current.set(cacheKey(cleanWord, sentence), data);
        // The example fetch can win the race and resolve first -- don't
        // clobber it if so.
        const existingExample = exampleCacheRef.current.get(cacheKey(cleanWord, sentence));
        setWordInfo(existingExample !== undefined ? { ...data, ...existingExample } : data);
        setIsLoading(false);
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) return;
        setError(
          err.name === "AbortError"
            ? `Looking up "${cleanWord}" is taking too long.`
            : err instanceof Error
              ? `Couldn't look up "${cleanWord}" (${err.message}).`
              : `Couldn't look up "${cleanWord}".`
        );
        setIsLoading(false);
      })
      .finally(() => clearTimeout(timeoutId));
  }, []);

  // Fetches JUST the example (+ any backfilled ipa/definition/respelling).
  // Also the retry path for a failed/stalled example specifically -- see
  // advanceOrRetry below, which calls this directly (not fetchWordInfo)
  // when the student taps/clicks while stuck on the example stage.
  const fetchExampleOnly = useCallback((cleanWord: string, sentence: string) => {
    const requestId = requestIdRef.current;
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    setExampleError(null);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    fetch(`${apiUrl}/api/word-example`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word: cleanWord, sentence }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `Backend returned ${res.status}`);
        }
        return res.json();
      })
      .then((data: WordExampleResponse) => {
        if (requestIdRef.current !== requestId) return;
        exampleCacheRef.current.set(cacheKey(cleanWord, sentence), data);
        // Merge into whatever's already there (from the quick fetch,
        // which can win the race and resolve first) -- data always
        // carries respelling now, and in the rarer partial/no-dictionary
        // cases also ipa and/or definition that Claude had to invent.
        setWordInfo((prev) => (prev ? { ...prev, ...data } : prev));
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) return;
        // Non-fatal -- stages 1-4 don't depend on this. Only the
        // example stage's own content needs to know it failed, and can
        // retry it (see advanceOrRetry).
        setExampleError(
          err.name === "AbortError"
            ? `Writing an example for "${cleanWord}" is taking too long.`
            : err instanceof Error
              ? `Couldn't write an example for "${cleanWord}" (${err.message}).`
              : `Couldn't write an example for "${cleanWord}".`
        );
      })
      .finally(() => clearTimeout(timeoutId));
  }, []);

  const fetchWordInfo = useCallback(
    (cleanWord: string, sentence: string) => {
      // Bumped here, read fresh by fetchQuickOnly/fetchExampleOnly for
      // their own staleness checks -- not passed down as a snapshot.
      requestIdRef.current += 1;
      setError(null);
      setExampleError(null);

      const cachedQuick = quickCacheRef.current.get(cacheKey(cleanWord, sentence));
      const cachedExample = exampleCacheRef.current.get(cacheKey(cleanWord, sentence));

      if (cachedQuick) {
        setWordInfo(cachedExample !== undefined ? { ...cachedQuick, ...cachedExample } : cachedQuick);
        setIsLoading(false);
      } else {
        setWordInfo(null);
        setIsLoading(true);
      }

      // Fired together, not one-after-the-other -- pronunciation/
      // definition/morphology/hear-aloud (the fast /api/word-info
      // response) don't need to wait on the example sentence (the slow
      // /api/word-example one), and vice versa. This is the whole point
      // of the fast/slow split: by the time the student has tapped
      // through the first four stages, the example call has almost
      // always already resolved in the background.
      if (!cachedQuick) fetchQuickOnly(cleanWord, sentence);
      if (cachedExample === undefined) fetchExampleOnly(cleanWord, sentence);
    },
    [fetchQuickOnly, fetchExampleOnly]
  );

  // Shared by tapWord (tapping the word again) and advanceStage (clicking
  // the box itself) -- both mean the same thing once a word is already
  // active: move to the next stage, or retry if the last fetch failed.
  // Declared before advanceOrRetry (which now calls it -- see the
  // "already on the last stage" branch below) purely for read-order;
  // JS closures don't actually require this, since advanceOrRetry's body
  // only runs later, well after this has been assigned, but keeping the
  // thing-that-gets-called-earlier physically earlier in the file avoids
  // needing to explain that fact to the next person reading it.
  const closeWord = useCallback(() => {
    setActiveWord(null);
  }, []);

  const advanceOrRetry = useCallback(
    (rawWordText: string, sentenceText: string) => {
      // A prior fetch for this word failed -- advancing should retry
      // rather than silently no-op (stages would still just be
      // ["pronunciation"] with nothing to advance into).
      if (!wordInfo && !isLoading && error) {
        fetchWordInfo(cleanWordText(rawWordText), sentenceText);
        return;
      }
      // Sitting on the example stage with nothing to show because the
      // background fetch failed (or stalled past FETCH_TIMEOUT_MS -- see
      // fetchExampleOnly). Advancing is already a no-op here (it's the
      // last stage), so repurpose the tap/click as a retry instead of
      // leaving the student stuck with no way to recover short of
      // tapping away and back.
      if (wordInfo && stages[stageIndex] === "example" && !wordInfo.example_sentence && exampleError) {
        fetchExampleOnly(cleanWordText(rawWordText), sentenceText);
        return;
      }
      // Already on the last stage with nothing left to retry -- another
      // tap/space/arrow here means "I'm done with this word," not "sit
      // here forever" (which is what the plain Math.min clamp below
      // would otherwise do). Closes the card instead. The actual reading
      // position (currentIndex in useReadingState) was never touched by
      // any part of looking a word up -- tapping/advancing a word's card
      // is entirely separate state -- so this just drops back to
      // whatever was already being read, with nothing having silently
      // advanced underneath the card.
      if (stageIndex === stages.length - 1) {
        closeWord();
        return;
      }
      setStageIndex((i) => {
        const next = Math.min(i + 1, stages.length - 1);
        if (stages[next] === "hearAloud" && next !== i) speak(wordInfo?.word ?? rawWordText);
        return next;
      });
    },
    [wordInfo, isLoading, error, exampleError, stages, stageIndex, fetchWordInfo, fetchExampleOnly, closeWord]
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
    exampleError,
    tapWord,
    advanceStage,
    closeWord,
    replayAudio,
  };
}
