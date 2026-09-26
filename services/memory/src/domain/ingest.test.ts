import { describe, expect, it } from "vitest";
import { advanceWatermark, IngestWatermarkError } from "./ingest.js";

describe("advanceWatermark", () => {
  it("advances to the larger seq", () => {
    expect(advanceWatermark(10, 12)).toBe(12);
  });

  it("never regresses — an older seq is ignored", () => {
    expect(advanceWatermark(10, 8)).toBe(10);
    expect(advanceWatermark(10, 10)).toBe(10);
  });

  it("starts from zero", () => {
    expect(advanceWatermark(0, 1)).toBe(1);
  });

  it("throws on a negative observed seq", () => {
    expect(() => advanceWatermark(10, -1)).toThrowError(IngestWatermarkError);
  });
});
