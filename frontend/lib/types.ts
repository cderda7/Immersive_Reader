// Flat syllable list, each tagged with (paragraph_idx, word_idx, syllable_idx).
// This is the shape the backend's /api/syllabify route returns, and the
// shape any static/precomputed passage data should match. Advancing the
// reading position is `currentIndex + 1` into this flat array -- no
// tree-walking needed to figure out what's "next".
export interface Syllable {
  text: string;
  paragraph_idx: number;
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
