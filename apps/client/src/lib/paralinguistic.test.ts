import { describe, expect, it } from "vitest";
import { PARALINGUISTIC_TAGS, stripTags, toDisplaySegments } from "./paralinguistic.js";

describe("toDisplaySegments", () => {
  it("splits supported tags into tag segments, preserving surrounding text", () => {
    const segments = toDisplaySegments("He laughs. [chuckle] Then he leaves.");
    expect(segments).toEqual([
      { type: "text", value: "He laughs. " },
      { type: "tag", label: "chuckle" },
      { type: "text", value: " Then he leaves." },
    ]);
  });

  it("matches tags case-insensitively", () => {
    const segments = toDisplaySegments("[Chuckle] hello");
    expect(segments).toEqual([{ type: "tag", label: "chuckle" }, { type: "text", value: " hello" }]);
  });

  it("handles the multi-word and edge tags", () => {
    for (const tag of PARALINGUISTIC_TAGS) {
      const segments = toDisplaySegments(`x [${tag}] y`);
      expect(segments).toEqual([
        { type: "text", value: "x " },
        { type: "tag", label: tag },
        { type: "text", value: " y" },
      ]);
    }
  });

  it("keeps unsupported bracketed text as plain text", () => {
    const segments = toDisplaySegments("The ledger says [REDACTED] on page two.");
    expect(segments).toEqual([
      { type: "text", value: "The ledger says [REDACTED] on page two." },
    ]);
  });

  it("round-trips: concat of values and re-bracketed labels equals the original", () => {
    const original = "A pause. [sigh] A breath. [shush] The room settles.";
    const roundTrip = toDisplaySegments(original)
      .map((segment) => (segment.type === "text" ? segment.value : `[${segment.label}]`))
      .join("");
    expect(roundTrip).toBe(original);
  });
});

describe("stripTags", () => {
  it("removes supported tags and collapses the doubled spaces", () => {
    expect(stripTags("A verdict. [chuckle] A price.")).toBe("A verdict. A price.");
  });

  it("leaves plain text and unsupported brackets alone", () => {
    expect(stripTags("The [REDACTED] line stays.")).toBe("The [REDACTED] line stays.");
  });
});