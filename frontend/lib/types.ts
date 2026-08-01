// Flat syllable list, each tagged with
// (paragraph_idx, sentence_idx, word_idx, syllable_idx). This is the shape
// the backend's /api/syllabify route returns, and the shape any
// static/precomputed passage data should match. Advancing the reading
// position is `currentIndex + 1` into this flat array -- no tree-walking
// needed to figure out what's "next". sentence_idx is paragraph-relative
// (resets each paragraph), same convention as word_idx.
export interface Syllable {
  text: string;
  paragraph_idx: number;
  sentence_idx: number;
  word_idx: number;
  syllable_idx: number;
  is_first_in_word: boolean;
  is_last_in_word: boolean;
}

// syllables grouped back into paragraphs -> words, for rendering only.
// (The flat array stays the source of truth for reading position.)
export type GroupedPassage = Syllable[][][];

export function groupSyllables(syllables: Syllable[]): GroupedPassage {
  const paragraphs: GroupedPassage = [];
  for (const syl of syllables) {
    paragraphs[syl.paragraph_idx] ??= [];
    paragraphs[syl.paragraph_idx][syl.word_idx] ??= [];
    paragraphs[syl.paragraph_idx][syl.word_idx][syl.syllable_idx] = syl;
  }
  return paragraphs;
}

// Reconstructs the full text of one (paragraphIdx, sentenceIdx) sentence
// from the flat syllable list. Same reconstruction rule as
// ReadingPane.tsx's getSentenceText (syllables within a word concatenate
// directly, words join with a single space) -- kept as a separate
// standalone helper here since this one needs to work from the flat list
// directly rather than a single paragraph's already-grouped words.
// Exported for SimplifySentenceFocus.tsx, which needs the text of TWO
// sentences out in each direction (see neighboringSentenceRef below),
// not just one.
export function sentenceTextAt(syllables: Syllable[], paragraphIdx: number, sentenceIdx: number): string {
  const words = new Map<number, string[]>();
  for (const s of syllables) {
    if (s.paragraph_idx !== paragraphIdx || s.sentence_idx !== sentenceIdx) continue;
    const texts = words.get(s.word_idx) ?? [];
    texts.push(s.text);
    words.set(s.word_idx, texts);
  }
  return [...words.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, texts]) => texts.join(""))
    .join(" ");
}

// (paragraphIdx, sentenceIdx) reference to a sentence -- what
// neighboringSentenceRef below returns, and what SimplifySentenceFocus.tsx
// chains to walk two sentences out in either direction (see
// sentenceFocusContext).
export interface SentenceRef {
  paragraphIdx: number;
  sentenceIdx: number;
}

// The sentence immediately before/after a given (paragraphIdx,
// sentenceIdx), as a REFERENCE (not text) -- so a caller can chain this
// to walk further than one sentence out (see sentenceFocusContext below),
// or resolve it to text/syllables itself. Crosses into the previous/next
// PARAGRAPH when the given sentence is the first/last one in its own
// paragraph, since sentence_idx resets per paragraph (same convention
// backend/syllabify.py and useReadingState.ts's unitDiffers both rely
// on) -- "previous" isn't always sentence_idx - 1 in the SAME paragraph.
// Returns null when there's no such sentence (e.g. asking what comes
// before the very first sentence of the passage).
export function neighboringSentenceRef(
  syllables: Syllable[],
  paragraphIdx: number,
  sentenceIdx: number,
  direction: "before" | "after"
): SentenceRef | null {
  // The flat list is sorted (paragraph, sentence, word, syllable) -- same
  // invariant useReadingState.ts's findNextIndex/findPreviousIndex rely
  // on -- so the syllable immediately outside this sentence's own index
  // range belongs to exactly the neighboring sentence in that direction.
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < syllables.length; i++) {
    const s = syllables[i];
    if (s.paragraph_idx === paragraphIdx && s.sentence_idx === sentenceIdx) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }
  if (firstIdx === -1) return null;

  const boundary = direction === "before" ? syllables[firstIdx - 1] : syllables[lastIdx + 1];
  if (!boundary) return null; // start/end of the passage -- no neighbor that direction

  return { paragraphIdx: boundary.paragraph_idx, sentenceIdx: boundary.sentence_idx };
}

// Text of the sentence immediately before/after a given (paragraphIdx,
// sentenceIdx) -- thin wrapper over neighboringSentenceRef + sentenceTextAt
// for the common one-sentence-of-context case.
export function neighboringSentenceText(
  syllables: Syllable[],
  paragraphIdx: number,
  sentenceIdx: number,
  direction: "before" | "after"
): string | null {
  const ref = neighboringSentenceRef(syllables, paragraphIdx, sentenceIdx, direction);
  if (!ref) return null;
  return sentenceTextAt(syllables, ref.paragraphIdx, ref.sentenceIdx);
}

// Every syllable belonging to one (paragraphIdx, sentenceIdx) sentence,
// in reading order -- the flat list is already sorted, so a plain filter
// preserves that order. Used by SimplifySentenceFocus.tsx to get the
// ORIGINAL sentence's real syllable-break data (already computed for the
// whole passage) to advance through, the same way
// simplify_sentence's simplified_syllables gives it the REWRITTEN
// sentence's.
export function sentenceSyllables(syllables: Syllable[], paragraphIdx: number, sentenceIdx: number): Syllable[] {
  return syllables.filter((s) => s.paragraph_idx === paragraphIdx && s.sentence_idx === sentenceIdx);
}

// How many sentences a paragraph has, by scanning for the highest
// sentence_idx any of its syllables carries. Used by sentenceFocusContext
// below to pull a WHOLE neighboring paragraph's worth of sentences at
// once, rather than one sentence at a time -- see that function's comment
// for why a whole paragraph, not a fixed count, is what "looks like the
// original paragraph" actually means.
function paragraphSentenceCount(syllables: Syllable[], paragraphIdx: number): number {
  let maxSentenceIdx = -1;
  for (const s of syllables) {
    if (s.paragraph_idx === paragraphIdx) maxSentenceIdx = Math.max(maxSentenceIdx, s.sentence_idx);
  }
  return maxSentenceIdx + 1;
}

// One paragraph's worth of context text for the focus reading view's
// top/bottom thirds -- either the CURRENT paragraph's own lead-in/trail-off
// around the active sentence, or a whole neighboring paragraph pulled in
// to satisfy the "at least 2 sentences" floor below. Rendered as one
// flowing prose block (see SimplifySentenceFocus.tsx), same as the real
// reading pane renders a paragraph -- never a fragment clipped mid-thought.
export interface ParagraphContextBlock {
  paragraphIdx: number;
  text: string;
}

export interface SentenceFocusContext {
  // Oldest paragraph first, ending with the current paragraph's own
  // lead-in (the sentences right before the active one) -- top-to-bottom
  // reading order, same as the passage itself.
  before: ParagraphContextBlock[];
  // The current paragraph's own trail-off (sentences right after the
  // active one) first, then any whole paragraphs pulled in after that.
  after: ParagraphContextBlock[];
}

// Floor on how many sentences of context show on each side -- NOT a
// fixed count. The current paragraph's own lead-in/trail-off around the
// active sentence always shows in full (0, 1, 2, or however many
// sentences it actually has), and only when that falls short of this
// floor do whole neighboring paragraphs get pulled in on top of it --
// see the loops below. Product direction: showing exactly 2 sentences
// regardless of paragraph shape read as an arbitrary clip; showing the
// paragraph's real boundary (with a minimum guarantee near passage
// edges, where a paragraph can be very short) reads as the original text.
const MIN_CONTEXT_SENTENCES = 2;

export function sentenceFocusContext(
  syllables: Syllable[],
  paragraphIdx: number,
  sentenceIdx: number
): SentenceFocusContext {
  // ---- before ----
  const leadSentences: string[] = [];
  for (let s = 0; s < sentenceIdx; s++) {
    leadSentences.push(sentenceTextAt(syllables, paragraphIdx, s));
  }

  const before: ParagraphContextBlock[] = [];
  let beforeCount = leadSentences.length;
  let cursorParagraph = paragraphIdx;
  while (beforeCount < MIN_CONTEXT_SENTENCES) {
    // Anchoring on this paragraph's OWN first sentence (not sentenceIdx,
    // which only applies to the original paragraph on the first
    // iteration) is what lets this loop keep walking further back for
    // paragraphs shorter than the floor on their own.
    const prevRef = neighboringSentenceRef(syllables, cursorParagraph, 0, "before");
    if (!prevRef) break; // reached the start of the passage
    const count = paragraphSentenceCount(syllables, prevRef.paragraphIdx);
    const sentences: string[] = [];
    for (let s = 0; s < count; s++) sentences.push(sentenceTextAt(syllables, prevRef.paragraphIdx, s));
    before.unshift({ paragraphIdx: prevRef.paragraphIdx, text: sentences.join(" ") });
    beforeCount += sentences.length;
    cursorParagraph = prevRef.paragraphIdx;
  }
  if (leadSentences.length > 0) {
    before.push({ paragraphIdx, text: leadSentences.join(" ") });
  }

  // ---- after ----
  const paragraphSentCount = paragraphSentenceCount(syllables, paragraphIdx);
  const trailSentences: string[] = [];
  for (let s = sentenceIdx + 1; s < paragraphSentCount; s++) {
    trailSentences.push(sentenceTextAt(syllables, paragraphIdx, s));
  }

  const after: ParagraphContextBlock[] = [];
  if (trailSentences.length > 0) {
    after.push({ paragraphIdx, text: trailSentences.join(" ") });
  }
  let afterCount = trailSentences.length;
  let cursorParagraphAfter = paragraphIdx;
  while (afterCount < MIN_CONTEXT_SENTENCES) {
    const lastSentenceIdx = paragraphSentenceCount(syllables, cursorParagraphAfter) - 1;
    const nextRef = neighboringSentenceRef(syllables, cursorParagraphAfter, lastSentenceIdx, "after");
    if (!nextRef) break; // reached the end of the passage
    const count = paragraphSentenceCount(syllables, nextRef.paragraphIdx);
    const sentences: string[] = [];
    for (let s = 0; s < count; s++) sentences.push(sentenceTextAt(syllables, nextRef.paragraphIdx, s));
    after.push({ paragraphIdx: nextRef.paragraphIdx, text: sentences.join(" ") });
    afterCount += sentences.length;
    cursorParagraphAfter = nextRef.paragraphIdx;
  }

  return { before, after };
}

// Prefix/suffix breakdown for the tap-word card's morphology stage, e.g.
// {parts: ["pre", "view"], note: "pre- (before) + view"} for "preview".
// null (not this shape) means the backend judged a breakdown not useful
// for this word -- see word_info.py's analyze_morphology.
export interface WordMorphology {
  parts: string[];
  note: string;
}

// Shape returned by POST /api/word-info, and what /api/word-example's
// response gets merged into (see useTapWord.ts's fetchWordInfo). ipa,
// respelling, definition, and morphology arrive fast (dictionary + rules,
// no LLM call) -- example_sentence starts as "" and is patched in
// slightly later once the background Claude call resolves, since it's
// the one field that's genuinely generative and can't be produced by
// rules. A "" example_sentence while on the example stage means "still
// writing one", not "this word has no example" -- see
// WordInfoPopover.tsx's StageContent.
export interface WordInfo {
  word: string;
  ipa: string;
  respelling: string;
  definition: string;
  morphology: WordMorphology | null;
  example_sentence: string;
}
