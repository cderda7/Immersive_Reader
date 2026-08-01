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
function sentenceTextAt(syllables: Syllable[], paragraphIdx: number, sentenceIdx: number): string {
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

// Text of the sentence immediately before/after a given (paragraphIdx,
// sentenceIdx), for showing surrounding context alongside a simplified
// sentence (see WordInfoPopover.tsx) -- so a student comparing the
// simplified wording can still see it in the flow of the passage around
// it, not just in isolation. Crosses into the previous/next PARAGRAPH
// when the given sentence is the first/last one in its own paragraph,
// since sentence_idx resets per paragraph (same convention
// backend/syllabify.py and useReadingState.ts's unitDiffers both rely
// on) -- "previous" isn't always sentence_idx - 1 in the SAME paragraph.
// Returns null when there's no such sentence (e.g. asking what comes
// before the very first sentence of the passage).
export function neighboringSentenceText(
  syllables: Syllable[],
  paragraphIdx: number,
  sentenceIdx: number,
  direction: "before" | "after"
): string | null {
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

  return sentenceTextAt(syllables, boundary.paragraph_idx, boundary.sentence_idx);
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
