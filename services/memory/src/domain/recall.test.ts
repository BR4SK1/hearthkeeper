import { describe, expect, it } from "vitest";
import {
  applyCharacterBudget,
  buildRecallFilter,
  rankCandidates,
  scoreCandidate,
} from "./recall.js";

describe("buildRecallFilter", () => {
  it("is campaign-scoped, active-only, and uses $text", () => {
    const filter = buildRecallFilter({ campaignId: "camp-1", text: "neon market" });
    expect(filter).toEqual({
      campaignId: "camp-1",
      status: "active",
      $text: { $search: "neon market" },
    });
  });

  it("includes kind when given", () => {
    const filter = buildRecallFilter({ campaignId: "c", text: "x", kind: "person" });
    expect(filter.kind).toBe("person");
  });

  it("has no vector or embedding key", () => {
    const filter = buildRecallFilter({ campaignId: "c", text: "x" });
    expect(JSON.stringify(filter)).not.toContain("vector");
    expect(JSON.stringify(filter)).not.toContain("embedding");
  });
});

describe("scoreCandidate", () => {
  it("ranks a stronger overlap higher", () => {
    const tokens = ["neon", "market"];
    const weak = scoreCandidate("The ship docked quietly.", tokens);
    const strong = scoreCandidate("The neon market stalls flickered in the rain market.", tokens);
    expect(strong).toBeGreaterThan(weak);
  });

  it("scores zero when nothing overlaps", () => {
    expect(scoreCandidate("a quiet street", ["neon"])).toBe(0);
  });
});

describe("rankCandidates", () => {
  it("sorts by descending score", () => {
    const ranked = rankCandidates(
      [{ id: "b", text: "quiet rain" }, { id: "a", text: "neon market rain" }],
      "neon rain",
    );
    expect(ranked[0].id).toBe("a");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
});

describe("applyCharacterBudget", () => {
  it("respects the budget", () => {
    const items = [
      { text: "aaaa" }, // 4
      { text: "bb" }, // cumulative 6 <= 8
      { text: "cccc" }, // cumulative 10 > 8 — dropped
    ];
    const kept = applyCharacterBudget(items, 8);
    expect(kept.map((i) => i.text)).toEqual(["aaaa", "bb"]);
  });

  it("always includes the first item even if over budget", () => {
    const items = [{ text: "0123456789" }, { text: "x" }];
    const kept = applyCharacterBudget(items, 5);
    expect(kept).toHaveLength(1);
    expect(kept[0].text).toBe("0123456789");
  });
});
