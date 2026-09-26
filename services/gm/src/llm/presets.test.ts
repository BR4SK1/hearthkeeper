import { describe, expect, it } from "vitest";
import { buildPresets } from "./presets.js";

describe("buildPresets", () => {
  it("defines the three task presets", () => {
    const presets = buildPresets("m");
    expect(Object.keys(presets).sort()).toEqual(["classification", "narration", "recap"]);
  });

  it("runs classification at temperature 0", () => {
    expect(buildPresets("m").classification.temperature).toBe(0);
  });

  it("gives every preset positive token budgets and valid temperatures", () => {
    const presets = buildPresets("m");
    for (const preset of Object.values(presets)) {
      expect(preset.model).toBe("m");
      expect(preset.maxTokens).toBeGreaterThan(0);
      expect(preset.temperature).toBeGreaterThanOrEqual(0);
      expect(preset.temperature).toBeLessThanOrEqual(1);
    }
  });
});

describe("buildPresets narration override", () => {
  it("defaults the narration budget to 700", () => {
    expect(buildPresets("m").narration.maxTokens).toBe(700);
  });

  it("honors the narration max-token override without touching other presets", () => {
    const presets = buildPresets("m", { narrationMaxTokens: 350 });
    expect(presets.narration.maxTokens).toBe(350);
    expect(presets.classification.maxTokens).toBe(200);
    expect(presets.recap.maxTokens).toBe(900);
  });
});
