import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILLER_BANK, loadFillerBank, pickFiller } from "./filler.js";

describe("FILLER_BANK", () => {
  it("contains the four settled canned acknowledgments", () => {
    const texts = FILLER_BANK.map((cue) => cue.text);
    expect(texts).toContain("Hmm...");
    expect(texts).toContain("Let me ponder that...");
    expect(texts).toContain("Now, let me see...");
    expect(texts).toContain("Interesting...");
  });
});

describe("pickFiller", () => {
  it("returns a member of the bank", () => {
    const cue = pickFiller();
    expect(FILLER_BANK).toContain(cue);
  });

  it("is deterministic with an injected rand", () => {
    const cue = pickFiller(FILLER_BANK, () => 0);
    expect(cue.id).toBe(FILLER_BANK[0].id);
  });

  it("clamps rand at the upper edge without going out of bounds", () => {
    const cue = pickFiller(FILLER_BANK, () => 1);
    expect(cue.id).toBe(FILLER_BANK[FILLER_BANK.length - 1].id);
  });
});

describe("loadFillerBank", () => {
  it("attaches audioHref for ids with a wav present, null for the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fillers-"));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "ack-hmm.wav"), "RIFF-fake");
      await writeFile(join(dir, "ack-see.wav"), "RIFF-fake");

      const { fillers, wavs } = await loadFillerBank(dir);

      const byId = new Map(fillers.map((f) => [f.id, f]));
      expect(byId.get("ack-hmm")?.audioHref).toBe("/v1/audio/fill-ack-hmm.wav");
      expect(byId.get("ack-hmm")?.audioPath).not.toBeNull();
      expect(byId.get("ack-see")?.audioHref).toBe("/v1/audio/fill-ack-see.wav");
      expect(byId.get("ack-ponder")?.audioHref).toBeNull();
      expect(byId.get("ack-ponder")?.audioPath).toBeNull();
      expect(byId.get("ack-interesting")?.audioHref).toBeNull();

      expect(wavs.get("fill-ack-hmm")?.length).toBeGreaterThan(0);
      expect(wavs.has("fill-ack-ponder")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("degrades gracefully on a missing directory: all null, no throw", async () => {
    const { fillers, wavs } = await loadFillerBank("/nonexistent/fillers/dir");
    expect(fillers).toHaveLength(FILLER_BANK.length);
    for (const filler of fillers) {
      expect(filler.audioHref).toBeNull();
      expect(filler.audioPath).toBeNull();
    }
    expect(wavs.size).toBe(0);
  });
});
