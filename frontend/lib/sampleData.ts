import type { Syllable } from "./types";

// Static demo passage, precomputed and shipped with the frontend (per the
// "content ships as static data" decision) so the core reading experience
// never depends on a live syllabification call. The PassageLoader panel
// on this screen still lets you run the real Pyphen-backed API against
// arbitrary text, as the scalability proof point.
const RAW: [string, string[][]][] = [
  [
    "The quick brown fox jumps over the lazy dog.",
    [
      ["The"], ["quick"], ["brown"], ["fox"], ["jumps"],
      ["o", "ver"], ["the"], ["la", "zy"], ["dog."],
    ],
  ],
  [
    "Reading fluency improves through consistent practice.",
    [
      ["Read", "ing"], ["flu", "en", "cy"], ["im", "proves"],
      ["through"], ["con", "sis", "tent"], ["prac", "tice."],
    ],
  ],
];

export const SAMPLE_SYLLABLES: Syllable[] = RAW.flatMap(([, words], paragraph_idx) =>
  words.flatMap((sylList, word_idx) =>
    sylList.map((text, syllable_idx) => ({
      text,
      paragraph_idx,
      word_idx,
      syllable_idx,
      is_first_in_word: syllable_idx === 0,
      is_last_in_word: syllable_idx === sylList.length - 1,
    }))
  )
);

export const SAMPLE_PASSAGE_TEXT = RAW.map(([text]) => text).join("\n\n");
