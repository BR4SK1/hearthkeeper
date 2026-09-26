import { describe, expect, it } from "vitest";
import { hearthkeeperTheme } from "./theme.js";

describe("hearthkeeperTheme", () => {
  it("is the campfire-dark theme", () => {
    expect(hearthkeeperTheme.palette.mode).toBe("dark");
    expect(hearthkeeperTheme.palette.primary.main).toBe("#ff8c1a");
    expect(hearthkeeperTheme.palette.background.default).toBe("#141110");
    expect(hearthkeeperTheme.palette.background.paper).toBe("#1e1813");
  });
});
