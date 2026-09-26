/**
 * Narration beat extraction: beats ≤300 chars,
 * split at paragraph/sentence boundaries, NEVER mid-sentence. Paralinguistic
 * tags like [chuckle] contain no sentence-terminators ([.!?…]) and no
 * newlines, so a tag can never be split across beats — it always stays
 * attached to the sentence it sits inside.
 */
export const MAX_BEAT_CHARS = 300;

/**
 * Cap for the FIRST beat only. Measured synthesis latency varies (Phase 4:
 * warm-repeat RTF ≈ 0.24–0.31, but first-synthesis-after-idle measured
 * 14.2 s and short lines up to 3.8 s under desktop contention) — a smaller
 * first beat is what makes first-audio land near the §7 window.
 * The thresholds keep spoken chunks manageable.
 */
export const FIRST_BEAT_MAX_CHARS = 180;

const SENTENCE_END = /[.!?…]/;
const CLOSING_PUNCTUATION = /[\"'’”)}\]]/;
const ABBREVIATION_END = /\b(?:e\.g|i\.e|mr|mrs|ms|dr|prof|sr|jr|vs|etc|st|no|fig|inc|ltd|u\.s|u\.k)\.$/i;

function isSentenceBoundary(text: string, start: number, terminator: number): boolean {
  if (text[terminator] === "." && ABBREVIATION_END.test(text.slice(start, terminator + 1))) return false;
  let after = terminator + 1;
  while (after < text.length && CLOSING_PUNCTUATION.test(text[after] ?? "")) after++;
  return after === text.length || /\s/.test(text[after] ?? "");
}

/**
 * Split one paragraph (no newlines) into sentences: a sentence ends at a
 * terminator ([.!?…]) followed by whitespace or end-of-text, so abbreviations
 * like "e.g." stay intact. Tags like [chuckle] hold no terminators and are
 * carried inside their sentence — never split.
 */
function splitSentences(paragraph: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < paragraph.length; i++) {
    if (SENTENCE_END.test(paragraph[i] ?? "") && isSentenceBoundary(paragraph, start, i)) {
      let end = i + 1;
      while (end < paragraph.length && CLOSING_PUNCTUATION.test(paragraph[end] ?? "")) end++;
      const sentence = paragraph.slice(start, end).trim();
      if (sentence.length > 0) sentences.push(sentence);
      start = end;
    }
  }
  const remainder = paragraph.slice(start).trim();
  if (remainder.length > 0) sentences.push(remainder);
  return sentences;
}

/** Take only sentences whose terminator and following whitespace have arrived. */
function takeCompleteSentences(paragraph: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < paragraph.length; i++) {
    if (!SENTENCE_END.test(paragraph[i] ?? "") || !isSentenceBoundary(paragraph, start, i)) continue;
    // At the end of a partial buffer, wait for either following whitespace or
    // final drain: the punctuation may still be part of an abbreviation.
    if (i + 1 >= paragraph.length) continue;
    let end = i + 1;
    while (end < paragraph.length && CLOSING_PUNCTUATION.test(paragraph[end] ?? "")) end++;
    const sentence = paragraph.slice(start, end).trim();
    if (sentence.length > 0) sentences.push(sentence);
    while (end < paragraph.length && /\s/.test(paragraph[end] ?? "")) end++;
    start = end;
    i = end - 1;
  }
  return { sentences, remainder: paragraph.slice(start) };
}

export class BeatExtractor {
  private buffer = "";
  private emitted = 0;

  constructor(private readonly opts: { firstBeatMaxChars?: number } = {}) {}

  /**
   * Feed one LLM delta; returns beats completed by this delta. Newlines
   * flush paragraphs; within a paragraph, consecutive sentences are packed
   * greedily into one beat while the total stays ≤ MAX_BEAT_CHARS (the
   * FIRST beat packs against the smaller firstBeatMaxChars cap instead).
   */
  push(delta: string): string[] {
    this.buffer += delta;
    return this.drain(false);
  }

  /** Flush the remaining buffer as final beat(s). */
  end(): string[] {
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const beats: string[] = [];

    // Newline(s) always end the current paragraph. Otherwise, complete
    // sentence boundaries are enough to dispatch speech while the LLM is
    // still generating the rest of its paragraph.
    let paragraphEnd: number;
    while ((paragraphEnd = this.buffer.indexOf("\n")) !== -1) {
      const paragraph = this.buffer.slice(0, paragraphEnd);
      this.buffer = this.buffer.slice(paragraphEnd + 1);
      this.emitParagraph(paragraph, beats);
    }
    if (final) {
      this.emitParagraph(this.buffer, beats);
      this.buffer = "";
    } else {
      const complete = takeCompleteSentences(this.buffer);
      this.emitSentences(complete.sentences, beats);
      this.buffer = complete.remainder;
    }

    this.emitted += beats.length;
    return beats;
  }

  private emitParagraph(paragraph: string, beats: string[]): void {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) return;
    this.emitSentences(splitSentences(trimmed), beats);
  }

  private emitSentences(sentences: string[], beats: string[]): void {
    // Greedy pack: accumulate sentences into a beat while the total stays
    // within the cap for THIS beat (the first beat packs against
    // firstBeatMaxChars; later beats against MAX_BEAT_CHARS). A sentence
    // longer than the cap becomes its own beat — never split mid-sentence.
    let current = "";
    for (const sentence of sentences) {
      const cap = this.emitted + beats.length === 0 ? this.opts.firstBeatMaxChars ?? FIRST_BEAT_MAX_CHARS : MAX_BEAT_CHARS;
      const candidate = current.length === 0 ? sentence : `${current} ${sentence}`;
      if (candidate.length <= cap) {
        current = candidate;
      } else {
        if (current.length > 0) beats.push(current);
        current = sentence; // even if the sentence alone exceeds the cap
      }
    }
    if (current.length > 0) beats.push(current);
  }
}

export function splitIntoBeats(
  text: string,
  opts?: { firstBeatMaxChars?: number },
): string[] {
  const extractor = new BeatExtractor(opts);
  return [...extractor.push(text), ...extractor.end()];
}
