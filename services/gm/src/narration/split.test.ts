import { describe, expect, it } from "vitest";
import { BeatExtractor, FIRST_BEAT_MAX_CHARS, MAX_BEAT_CHARS, splitIntoBeats } from "./split.js";

const shortSentences = Array.from({ length: 14 }, (_, i) => `Sentence number ${i + 1} moves the story along.`);

describe("splitIntoBeats", () => {
  it("splits paragraphs into separate beats", () => {
    const beats = splitIntoBeats("First paragraph, one thought.\n\nSecond paragraph, another thought.");
    expect(beats).toEqual(["First paragraph, one thought.", "Second paragraph, another thought."]);
  });

  it("greedily packs short sentences while beats stay within the cap", () => {
    const text = shortSentences.join(" ");
    const beats = splitIntoBeats(text);
    expect(beats.length).toBeGreaterThan(1);
    for (const beat of beats) {
      expect(beat.length).toBeLessThanOrEqual(MAX_BEAT_CHARS);
    }
    expect(beats.join(" ")).toBe(text); // no words lost
  });

  it("caps the first beat smaller (measured-latency tuning, §7)", () => {
    // ~10 short sentences ≈ 500 chars: with the default first-beat cap of
    // 180 the first beat must stop at a sentence boundary at or before 180
    // chars; later beats still pack up to 300.
    const text = shortSentences.join(" ");
    const beats = splitIntoBeats(text);
    expect(beats.length).toBeGreaterThan(2);
    expect(beats[0].length).toBeLessThanOrEqual(FIRST_BEAT_MAX_CHARS);
    expect(beats[0].endsWith(".")).toBe(true); // sentence boundary, not mid-sentence
    for (const beat of beats.slice(1)) {
      expect(beat.length).toBeLessThanOrEqual(MAX_BEAT_CHARS);
    }
    expect(beats.join(" ")).toBe(text); // no words lost
  });

  it("keeps an over-long first sentence whole even under the first-beat cap", () => {
    const longSentence = `${"The opening clause rambles far beyond any cap ".repeat(5).trim()}.`;
    expect(longSentence.length).toBeGreaterThan(FIRST_BEAT_MAX_CHARS);
    const beats = splitIntoBeats(longSentence);
    expect(beats).toEqual([longSentence]);
  });

  it("never splits mid-sentence: a single over-long sentence is its own beat", () => {
    const longSentence = `${"A very long clause that keeps going and going ".repeat(9).trim()}.`;
    expect(longSentence.length).toBeGreaterThan(MAX_BEAT_CHARS);
    const beats = splitIntoBeats(longSentence);
    expect(beats).toHaveLength(1);
    expect(beats[0]).toBe(longSentence);
  });

  it("keeps a paralinguistic tag intact in exactly one beat at a would-be boundary", () => {
    // The tag sits just before the point where the greedy packer must roll
    // to a new beat (first+tag ≈ 53 chars; adding the ~250-char second
    // sentence overflows the cap), so a naive char-count splitter would
    // risk cutting the tag in half.
    const first = "The fixer leans back and weighs the offer.";
    const second =
      "The deal smells like burnt ozone and bad credit, and everyone in the room knows it, and yet nobody walks away, because walking away would mean admitting that the whole run, the stakeout, the bribery, the lies, was for nothing at all in the end, and pride is the one currency this city never devalues.";
    const beats = splitIntoBeats(`${first} [chuckle] ${second}`);
    expect(beats).toHaveLength(2);
    const withTag = beats.filter((b) => b.includes("[chuckle]"));
    expect(withTag).toHaveLength(1);
    expect(withTag[0]).toContain("[chuckle]");
    // The tag is never cut: both bracket halves never appear in different beats.
    expect(beats.filter((b) => /\[[a-z ]*$|^[a-z ]*\]/.test(b.trim()))).toHaveLength(0);
  });

  it("drops whitespace-only input to no beats", () => {
    expect(splitIntoBeats("   \n\n  \n ")).toEqual([]);
  });

  it("treats abbreviation-adjacent periods as non-terminators", () => {
    const beats = splitIntoBeats("Meet me at the e.g. usual spot by the pier.");
    expect(beats).toEqual(["Meet me at the e.g. usual spot by the pier."]);
  });
});

describe("BeatExtractor incremental streaming", () => {
  it("push() over deltas equals splitIntoBeats(whole)", () => {
    const text = [
      "The rain hammers the awning outside the diner.",
      "Inside, the fixer slides a photo across the formica.",
      "[sigh] You knew this job would end badly.",
      "The question is who ends up holding the bill.",
    ].join("\n");

    const extractor = new BeatExtractor();
    const streamed: string[] = [];
    for (let i = 0; i < text.length; i += 7) {
      streamed.push(...extractor.push(text.slice(i, i + 7)));
    }
    streamed.push(...extractor.end());

    expect(streamed).toEqual(splitIntoBeats(text));
expect(streamed.length).toBeGreaterThan(1);
  });

  it("flushes a paragraph when the newline arrives mid-delta", () => {
    const extractor = new BeatExtractor();
    const first = extractor.push("One complete paragraph here.\nTwo");
    expect(first).toEqual(["One complete paragraph here."]);
    const rest = extractor.end();
    expect(rest).toEqual(["Two"]);
  });

  it("dispatches a completed sentence before its paragraph or LLM stream ends", () => {
    const extractor = new BeatExtractor();
    expect(extractor.push("The door opens. ")).toEqual(["The door opens."]);
    expect(extractor.push("A second sentence is still forming")).toEqual([]);
    expect(extractor.end()).toEqual(["A second sentence is still forming"]);
  });

  it("does not dispatch a sentence abbreviation as a paragraph boundary", () => {
    const extractor = new BeatExtractor();
    expect(extractor.push("Use e.g. a clean alias ")).toEqual([]);
    expect(extractor.push("before the meeting. ")).toEqual(["Use e.g. a clean alias before the meeting."]);
  });
});
