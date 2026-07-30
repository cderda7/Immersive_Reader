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
