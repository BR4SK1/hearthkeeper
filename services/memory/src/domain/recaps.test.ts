import { describe, expect, it } from "vitest";
import { servableRecap, type SessionRecap } from "./recaps.js";

const recap = (sessionNumber: number, superseded = false): SessionRecap => ({
  campaignId: "camp-1",
  sessionNumber,
  text: `recap ${sessionNumber}`,
  superseded,
});

describe("servableRecap", () => {
  it("picks the highest non-superseded recap at or before the requested session", () => {
    const recaps = [recap(1), recap(3), recap(5)];
    expect(servableRecap(recaps, 5)?.sessionNumber).toBe(5);
    expect(servableRecap(recaps, 4)?.sessionNumber).toBe(3);
  });

  it("skips superseded recaps", () => {
    const recaps = [recap(1), recap(3, true), recap(2)];
    expect(servableRecap(recaps, 3)?.sessionNumber).toBe(2);
  });

  it("returns null when nothing qualifies", () => {
    expect(servableRecap([recap(5)], 4)).toBeNull();
    expect(servableRecap([recap(1, true)], 1)).toBeNull();
    expect(servableRecap([], 3)).toBeNull();
  });
});
