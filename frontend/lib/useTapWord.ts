"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { Syllable, WordInfo } from "./types";

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

// Shape POST /api/simplify-sentence returns -- see
// word_info.py's simplify_sentence. needs_simplification false means the
// sentence was already judged plain/literal/at-grade-level -- simplified
// is "" (and simplified_syllables []) in that case. simplified_syllables
// is the rewritten sentence's own real syllable breaks (same flat shape
// as the passage's syllables) -- what lets the focus view advance
// through it syllable-by-syllable with the same machinery as normal
// reading, instead of a plain string it has no break data for.
export interface SimplifiedSentence {
  needs_simplification: boolean;
  simplified: string;
  simplified_syllables: Syllable[];
}

// Gate used everywhere a caller decides whether it's worth showing the
// simplified-sentence focus view at all (see openSimplifyFocus/
// openSimplifyFocusForWord below) -- product direction, Aug 1 2026: a
// sentence that doesn't get a translation (already at/below grade level,
// or a malformed/empty model response) should never pull the student out
// of whatever view they were already on. `data` is null on a fetch
// error too (see runSimplify's onResolved calls), which this correctly
// treats as "not usable" -- an error still surfaces via simplifyError
// for a caller that's already in the focus view (the "Try again" retry
// path), just never as a reason to OPEN it in the first place.
function hasUsableSimplification(data: SimplifiedSentence | null): boolean {
  return !!data?.needs_simplification && data.simplified_syllables.length > 0;
}

export function useTapWord(gradeLevel: number = 9) {
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

  // True once the DEFINITION shown is the one the background Claude call
  // confirmed/corrected (see word_info.py's "Word-sense disambiguation"
  // docstring section) rather than just get_word_info_quick's fast
  // word-overlap guess. Both fetches fire together at tap time, but the
  // fast one almost always resolves first with a real dictionary
  // definition already in hand -- so without this flag, WordInfoPopover
  // would show that guess immediately and then have it silently swap out
  // from under the student's eyes a moment later whenever the slow call
  // picks a DIFFERENT sense than the guess did (a real, not rare,
  // occurrence for any multi-sense word). StageContent's "definition"
  // case withholds the text entirely until this is true, showing a
  // loading state instead -- same "don't show it until it's real"
  // pattern example_sentence already uses (that field just starts as ""
  // to mean the same thing; definition can't use an empty string the
  // same way since the fast guess is rarely actually empty). Reset to
  // false by fetchWordInfo below every time a genuinely new word/
  // sentence pair is looked up, unless the confirmed answer is already
  // cached; set true the instant fetchExampleOnly's response lands,
  // since that's the SAME background call that resolves the definition.
  const [isDefinitionConfirmed, setIsDefinitionConfirmed] = useState(false);

  // "Simplify sentence" -- deliberately separate from the
  // pronunciation/definition/morphology/hear-aloud/example stage cycle
  // above: it acts on the whole sentence the tapped word came from, not
  // the word, and is available the instant the card opens regardless of
  // which stage the student is on (see WordInfoPopover.tsx). gradeLevel
  // comes from the teacher-configured link (see ReadingScreen.tsx),
  // defaulting to 9 when opened without one (e.g. local dev).
  const [simplifiedSentence, setSimplifiedSentence] = useState<SimplifiedSentence | null>(null);
  const [isSimplifying, setIsSimplifying] = useState(false);
  const [simplifyError, setSimplifyError] = useState<string | null>(null);
  const simplifyCacheRef = useRef<Map<string, SimplifiedSentence>>(new Map());

  // Whether the full-screen simplify-sentence FOCUS view is showing
  // (SimplifySentenceFocus.tsx) -- separate from simplifiedSentence
  // itself being populated, since opening focus mode and fetching the
  // simplified rewrite happen together (see openSimplifyFocus below):
  // the recentered layout appears immediately, with a loading state,
  // rather than waiting on the fetch first. ReadingScreen.tsx renders
  // WordInfoPopover XOR SimplifySentenceFocus off this flag -- never
  // both, so there's only ever one place listening for
  // Space/ArrowRight/ArrowLeft/Escape while a word is active.
  const [isSimplifyFocusOpen, setIsSimplifyFocusOpen] = useState(false);

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
        // carries respelling and a definition now (the latter is the
        // confirmed/corrected word-sense pick, not just Claude's
        // invention for the rarer no-dictionary case -- see
        // word_info.py's _generate_enrichment), and in the rarer
        // partial/no-dictionary case also an ipa Claude had to invent.
        setWordInfo((prev) => (prev ? { ...prev, ...data } : prev));
        // This IS the confirmation -- see isDefinitionConfirmed's own
        // comment above.
        setIsDefinitionConfirmed(true);
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
      // Already confirmed if this exact (word, sentence) was resolved
      // before (cache hit) -- otherwise wait for fetchExampleOnly's own
      // response to flip this, same as a brand-new word does.
      setIsDefinitionConfirmed(cachedExample !== undefined);

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
      // Same failure, but caught earlier -- sitting on the DEFINITION
      // stage with nothing to show because that same background fetch
      // failed (see isDefinitionConfirmed's comment above: it's the
      // confirmed definition, not just the invented one, that comes from
      // this call). Unlike the example stage, definition isn't the last
      // stage, so without this a tap/space here would just silently
      // advance past the error into morphology instead of offering a
      // retry -- a student would have to keep going all the way to
      // example before getting a chance to fix it.
      if (wordInfo && stages[stageIndex] === "definition" && !isDefinitionConfirmed && exampleError) {
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
    [
      wordInfo,
      isLoading,
      error,
      exampleError,
      isDefinitionConfirmed,
      stages,
      stageIndex,
      fetchWordInfo,
      fetchExampleOnly,
      closeWord,
    ]
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
      // A genuinely new word (possibly a new sentence too) -- any
      // simplification shown belonged to the PREVIOUS sentence, so it
      // shouldn't linger under the new card. Re-simplifying (if the
      // student clicks the button again) hits simplifyCacheRef instantly
      // when it's actually the same sentence, so this costs nothing in
      // the common "another word, same sentence" case.
      setSimplifiedSentence(null);
      setSimplifyError(null);
      setIsSimplifying(false);
      setIsSimplifyFocusOpen(false);
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

  // ArrowLeft while the card is open (WordInfoPopover.tsx) -- mirrors
  // advanceOrRetry's forward path, but backward. Already on the FIRST
  // stage (pronunciation, index 0) means there's nowhere earlier to
  // retreat to -- same "nothing left here, so this key means I'm done
  // with this word" logic advanceOrRetry applies at the LAST stage, just
  // at the other end of the stage list: closes the card instead of
  // sitting inert, dropping back to whatever was already being read (the
  // actual reading position was never touched by looking a word up, same
  // as closeWord elsewhere). Retreating back INTO hearAloud replays the
  // word out loud too, mirroring advanceOrRetry's own speak-on-arrival so
  // audio plays consistently regardless of which direction landed there.
  const retreatStage = useCallback(() => {
    if (!activeWord) return;
    if (stageIndex === 0) {
      closeWord();
      return;
    }
    setStageIndex((i) => {
      const prev = Math.max(i - 1, 0);
      if (stages[prev] === "hearAloud" && prev !== i) speak(wordInfo?.word ?? activeWord.word);
      return prev;
    });
  }, [activeWord, stageIndex, stages, wordInfo, closeWord]);

  const replayAudio = useCallback(() => {
    if (wordInfo) speak(wordInfo.word);
  }, [wordInfo]);

  function simplifyCacheKey(sentence: string, grade: number): string {
    return `${sentence} ${grade}`;
  }

  // Does the actual fetch (or cache reuse) for a simplified rewrite of
  // `sentence` at the teacher-configured grade level. Extracted from
  // simplifySentence below (which sources `sentence` from activeWord
  // state) so openSimplifyFocusForWord can also call it with a sentence
  // it already has in hand -- from the word that was just hovered/clicked
  // in ReadingPane.tsx, not yet reflected in activeWord state (setState
  // is async; reading activeWord.sentenceText back in the same callback
  // that just set it would still see the PREVIOUS word). Reuses
  // requestIdRef for the same staleness reason as fetchWordInfo/
  // fetchExampleOnly: if the student moves on to a different word before
  // this resolves, the response is stale and should be ignored rather
  // than clobbering whatever's now active.
  //
  // onResolved (optional): fires with the resolved SimplifiedSentence, or
  // null on error/staleness -- lets a caller decide what to do ONLY once
  // the real answer is known, e.g. openSimplifyFocusForWord below gating
  // whether to open the focus view at all on hasUsableSimplification(data)
  // instead of opening it eagerly and finding out after the fact.
  const runSimplify = useCallback(
    (sentence: string, onResolved?: (data: SimplifiedSentence | null) => void) => {
      const cacheKeyStr = simplifyCacheKey(sentence, gradeLevel);
      const cached = simplifyCacheRef.current.get(cacheKeyStr);
      if (cached !== undefined) {
        setSimplifiedSentence(cached);
        setSimplifyError(null);
        onResolved?.(cached);
        return;
      }

      const requestId = requestIdRef.current;
      const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
      setIsSimplifying(true);
      setSimplifyError(null);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      fetch(`${apiUrl}/api/simplify-sentence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence, grade_level: gradeLevel }),
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.error ?? `Backend returned ${res.status}`);
          }
          return res.json();
        })
        .then((data: SimplifiedSentence) => {
          if (requestIdRef.current !== requestId) return; // stale -- student tapped away
          simplifyCacheRef.current.set(cacheKeyStr, data);
          setSimplifiedSentence(data);
          setIsSimplifying(false);
          onResolved?.(data);
        })
        .catch((err) => {
          if (requestIdRef.current !== requestId) return;
          onResolved?.(null);
          setSimplifyError(
            err.name === "AbortError"
              ? "Simplifying this sentence is taking too long."
              : err instanceof Error
                ? `Couldn't simplify this sentence (${err.message}).`
                : "Couldn't simplify this sentence."
          );
          setIsSimplifying(false);
        })
        .finally(() => clearTimeout(timeoutId));
    },
    [gradeLevel]
  );

  // Fetches (or reuses a cached) simplified rewrite of the active word's
  // sentence -- thin wrapper over runSimplify for the ordinary case where
  // activeWord is already set (WordInfoPopover.tsx's "🪄 Simplify
  // sentence" button, via openSimplifyFocus below).
  const simplifySentence = useCallback(() => {
    if (!activeWord) return;
    runSimplify(activeWord.sentenceText);
  }, [activeWord, runSimplify]);

  // Entry point for the "🪄 Simplify sentence" button (WordInfoPopover.tsx).
  // Product direction, Aug 1 2026: a sentence that doesn't need/get a
  // translation should never pull the student out of the tap-to-define
  // card they're already looking at -- so this WAITS on the fetch (or
  // cache hit) and only flips to the full-screen focus view once
  // hasUsableSimplification confirms there's actually something to show.
  // isSimplifying still flips true immediately (runSimplify sets it),
  // which WordInfoPopover's button reads to show its own pending state
  // -- the student sees SOMETHING happen on click even though the view
  // itself doesn't change yet.
  const openSimplifyFocus = useCallback(() => {
    if (!activeWord) return;
    runSimplify(activeWord.sentenceText, (data) => {
      if (hasUsableSimplification(data)) setIsSimplifyFocusOpen(true);
      // else: stays on WordInfoPopover, nothing else to do -- simplifyError
      // (network failure) or simplifiedSentence.needs_simplification===false
      // (already at/below grade level) both just mean "no translation,"
      // and simplifySentence/simplifiedSentence state is still set for
      // anything that wants to read it later.
    });
  }, [activeWord, runSimplify]);

  // Entry point for the reading pane's own hover-triggered "SIMPLIFY
  // SENTENCE" chip (see ReadingPane.tsx's per-word wrapper, mirroring the
  // existing JUMP HERE chip, just anchored below the word instead of
  // above). Same "don't leave the original view for nothing" rule as
  // openSimplifyFocus above, just more so here -- this path skips the
  // tap-to-define card entirely, so activeWord is deliberately NOT set
  // until the fetch resolves as usable either. Setting it early (like the
  // old version did) would make ReadingScreen.tsx's `activeWord &&
  // !isSimplifyFocusOpen` condition flash the ORDINARY WordInfoPopover
  // card during the pending fetch -- a card this entry point was never
  // supposed to show at all. Deferring both setActiveWord and
  // setIsSimplifyFocusOpen to the same onResolved callback keeps the
  // reading pane exactly as it was, the whole time, until (and unless)
  // there's really something to show.
  const openSimplifyFocusForWord = useCallback(
    (paragraphIdx: number, wordIdx: number, sentenceIdx: number, wordText: string, sentenceText: string) => {
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;
      setStageIndex(0);
      setWordInfo(null);
      setIsLoading(false);
      setError(null);
      setExampleError(null);
      setIsDefinitionConfirmed(false);
      setSimplifiedSentence(null);
      setSimplifyError(null);
      setIsSimplifying(false);
      runSimplify(sentenceText, (data) => {
        if (requestIdRef.current !== requestId) return; // student moved on already
        if (hasUsableSimplification(data)) {
          setActiveWord({ paragraphIdx, wordIdx, sentenceIdx, word: wordText, sentenceText });
          setIsSimplifyFocusOpen(true);
        }
        // else: never leaves the reading pane -- no card, no focus view.
      });
    },
    [runSimplify]
  );

  // Leaving the focus view WITHOUT having read all the way through it
  // (Escape, the close button, or retreating past its first unit -- see
  // SimplifySentenceFocus.tsx) -- closes the whole card, same as
  // closeWord elsewhere, since there's no sensible smaller state to fall
  // back to once the student has already jumped into the big recentered
  // view. Reading position is untouched (closeWord never touches it) --
  // this is for backing all the way out without the "continue reading
  // past this sentence" jump that finishing the view for real triggers
  // (see ReadingScreen.tsx's onExitContinue, which calls
  // jumpPastSentence + closeWord together instead of just this).
  const closeSimplifyFocus = useCallback(() => {
    setIsSimplifyFocusOpen(false);
    closeWord();
  }, [closeWord]);

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
    isDefinitionConfirmed,
    tapWord,
    advanceStage,
    retreatStage,
    closeWord,
    replayAudio,
    simplifiedSentence,
    isSimplifying,
    simplifyError,
    simplifySentence,
    isSimplifyFocusOpen,
    openSimplifyFocus,
    openSimplifyFocusForWord,
    closeSimplifyFocus,
  };
}
