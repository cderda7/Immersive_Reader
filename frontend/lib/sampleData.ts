import type { Syllable } from "./types";

// Static demo passage, precomputed and shipped with the frontend (per the
// "content ships as static data" decision) so the core reading experience
// never depends on a live syllabification call. The PassageLoader panel
// on this screen still lets you run the real Pyphen-backed API against
// arbitrary text, as the scalability proof point.
//
// Each paragraph is TWO sentences here (not one, like the original demo
// text) specifically so the sentence-fade effect has something to show --
// a single-sentence paragraph never crosses a sentence boundary, so the
// fade would never trigger against this sample data.
const RAW: [string[], string[][]][] = [
  [
    ["The quick brown fox jumps over the lazy dog.", "It runs fast and jumps high today."],
    [
      ["The"], ["quick"], ["brown"], ["fox"], ["jumps"],
      ["o", "ver"], ["the"], ["la", "zy"], ["dog."],
      ["It"], ["runs"], ["fast"], ["and"], ["jumps"], ["high"], ["to", "day."],
    ],
  ],
  [
    ["Reading fluency improves through consistent practice.", "Even short pauses help you build confidence."],
    [
      ["Read", "ing"], ["flu", "en", "cy"], ["im", "proves"],
      ["through"], ["con", "sis", "tent"], ["prac", "tice."],
      ["E", "ven"], ["short"], ["paus", "es"], ["help"], ["you"], ["build"], ["con", "fi", "dence."],
    ],
  ],
];

// Word counts of the FIRST sentence in each paragraph, used below to
// figure out which sentence a given word_idx falls into (word_idx keeps
// counting across sentence boundaries within a paragraph, same convention
// backend/syllabify.py uses).
const FIRST_SENTENCE_WORD_COUNTS = [9, 6];

export const SAMPLE_SYLLABLES: Syllable[] = RAW.flatMap(([, words], paragraph_idx) =>
  words.flatMap((sylList, word_idx) => {
    const sentence_idx = word_idx < FIRST_SENTENCE_WORD_COUNTS[paragraph_idx] ? 0 : 1;
    return sylList.map((text, syllable_idx) => ({
      text,
      paragraph_idx,
      sentence_idx,
      word_idx,
      syllable_idx,
      is_first_in_word: syllable_idx === 0,
      is_last_in_word: syllable_idx === sylList.length - 1,
    }));
  })
);

export const SAMPLE_PASSAGE_TEXT = RAW.map(([sentences]) => sentences.join(" ")).join("\n\n");
