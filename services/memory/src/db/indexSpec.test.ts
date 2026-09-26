import { describe, expect, it } from "vitest";
import { MEMORY_INDEXES } from "./indexSpec.js";

describe("MEMORY_INDEXES", () => {
  it("leads every non-text index with campaignId: 1", () => {
    for (const spec of MEMORY_INDEXES) {
      const isTextIndex = Object.values(spec.keys).includes("text");
      if (!isTextIndex) {
        expect(spec.keys.campaignId, spec.options.name).toBe(1);
      }
    }
  });

  it("gives the observations text index the settled weights", () => {
    const textIndex = MEMORY_INDEXES.find((s) => s.options.name === "obs_text_search");
    expect(textIndex).toBeDefined();
    expect(textIndex?.keys).toEqual({ text: "text", subjectKey: "text" });
    expect(textIndex?.options.weights).toEqual({ text: 3, subjectKey: 2 });
  });

  it("contains no vector index anywhere", () => {
    expect(JSON.stringify(MEMORY_INDEXES)).not.toContain("vector");
  });

  it("defines the recaps and ingest indexes", () => {
    const names = MEMORY_INDEXES.map((s) => s.options.name);
    expect(names).toContain("recaps_by_campaign_session");
    expect(names).toContain("ingest_by_campaign_seq");
  });
});
