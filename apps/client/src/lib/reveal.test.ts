import { describe, expect, it } from "vitest";
import { charsVisible, resolveBeatDuration, tagAwareReveal } from "./reveal.js";
import type { DisplaySegment } from "./paralinguistic.js";

const SEGMENTS: DisplaySegment[] = [
  { type: "text", value: "AB" },
  { type: "tag", label: "chuckle" },
  { type: "text", value: "CD" },
];

describe("charsVisible", () => {
  it("audio mode: proportional, full at end, clamped past the end", () => {
    expect(charsVisible(500, { total: 10, durationMs: 1000 })).toBe(5);
    expect(charsVisible(1000, { total: 10, durationMs: 1000 })).toBe(10);
    expect(charsVisible(5000, { total: 10, durationMs: 1000 })).toBe(10);
  });

  it("text mode: linear at cps (default 16)", () => {
    expect(charsVisible(1000, { total: 100 })).toBe(16);
    expect(charsVisible(2000, { total: 100, cps: 8 })).toBe(16);
    expect(charsVisible(10000, { total: 20 })).toBe(20);
  });

  it("clamps negative elapsed and degenerate totals", () => {
    expect(charsVisible(-50, { total: 10, durationMs: 1000 })).toBe(0);
    expect(charsVisible(50, { total: 0 })).toBe(0);
  });

  it("is stable for identical inputs", () => {
    expect(charsVisible(300, { total: 7, durationMs: 900 })).toBe(
      charsVisible(300, { total: 7, durationMs: 900 }),
    );
  });
});

describe("tagAwareReveal", () => {
  it("shows nothing at zero", () => {
    expect(tagAwareReveal(SEGMENTS, 0)).toEqual([]);
  });

  it("truncates the first text segment before reaching the tag", () => {
    expect(tagAwareReveal(SEGMENTS, 1)).toEqual([{ type: "text", value: "A" }]);
  });

  it("reveals a tag only once the cursor passes its offset (text 'AB' = 2 chars, tag costs 1)", () => {
    expect(tagAwareReveal(SEGMENTS, 2)).toEqual([{ type: "text", value: "AB" }]);
    expect(tagAwareReveal(SEGMENTS, 3)).toEqual([
      { type: "text", value: "AB" },
      { type: "tag", label: "chuckle" },
    ]);
  });

  it("reveals everything when the cursor passes the full cost", () => {
    expect(tagAwareReveal(SEGMENTS, 5)).toEqual(SEGMENTS);
    expect(tagAwareReveal(SEGMENTS, 99)).toEqual(SEGMENTS);
  });

  it("carries the remainder on the last text segment", () => {
    expect(tagAwareReveal(SEGMENTS, 4)).toEqual([
      { type: "text", value: "AB" },
      { type: "tag", label: "chuckle" },
      { type: "text", value: "C" },
    ]);
  });
});
describe("resolveBeatDuration", () => {
  it("prefers the server-provided PCM duration over a bogus audioDuration", () => {
    expect(resolveBeatDuration({ durationMs: 2000, audioDuration: 0.01 })).toBe(2000);
  });

  it("falls back to a finite positive audioDuration", () => {
    expect(resolveBeatDuration({ durationMs: null, audioDuration: 1.5 })).toBe(1.5);
    expect(resolveBeatDuration({ durationMs: undefined, audioDuration: 1.5 })).toBe(1.5);
  });

  it("ignores non-finite, zero, and negative audioDuration", () => {
    expect(resolveBeatDuration({ durationMs: null, audioDuration: Number.NaN })).toBeNull();
    expect(resolveBeatDuration({ durationMs: null, audioDuration: Infinity })).toBeNull();
    expect(resolveBeatDuration({ durationMs: null, audioDuration: 0 })).toBeNull();
    expect(resolveBeatDuration({ durationMs: null, audioDuration: -1 })).toBeNull();
  });

  it("returns null when neither source is usable (→ text-pace fallback)", () => {
    expect(resolveBeatDuration({ durationMs: null, audioDuration: null })).toBeNull();
    expect(resolveBeatDuration({})).toBeNull();
    expect(resolveBeatDuration({ durationMs: 0, audioDuration: Number.NaN })).toBeNull();
  });
});
