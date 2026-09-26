/**
 * Filler bank: the pre-rendered acknowledgment audio that plays during the
 * handoff/ack window while the GM LLM thinks. Wavs are
 * rendered once by scripts/generate-fillers.ts into the assets dir; when a
 * wav is missing the filler still plays as text (audioPath null, graceful).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface FillerCue {
  id: string;
  text: string;
  audioPath: string | null;
}

export interface FillerWithAudio extends FillerCue {
  audioHref: string | null;
}

export const FILLER_BANK: FillerCue[] = [
  { id: "ack-hmm", text: "Hmm...", audioPath: null },
  { id: "ack-ponder", text: "Let me ponder that...", audioPath: null },
  { id: "ack-see", text: "Now, let me see...", audioPath: null },
  { id: "ack-interesting", text: "Interesting...", audioPath: null },
];

/** Pick a cue; deterministic when an injected rand is provided. */
export function pickFiller(
  bank: FillerCue[] = FILLER_BANK,
  rand: () => number = Math.random,
): FillerCue {
  if (bank.length === 0) {
    throw new Error("filler bank is empty; cannot pick a cue");
  }
  const index = Math.min(bank.length - 1, Math.max(0, Math.floor(rand() * bank.length)));
  return bank[index];
}

/**
 * Load the filler bank with per-cue audio: reads <id>.wav from assetsDir
 * when present, exposing audioHref("/v1/audio/fill-<id>") and the wav
 * bytes under the cache key the audio route serves. A missing file (or
 * missing dir) leaves that cue's audioPath null — no throw, graceful.
 */
export async function loadFillerBank(assetsDir: string): Promise<{
  fillers: FillerWithAudio[];
  wavs: Map<string, Buffer>;
}> {
  const fillers: FillerWithAudio[] = [];
  const wavs = new Map<string, Buffer>();

  for (const cue of FILLER_BANK) {
    const file = join(assetsDir, `${cue.id}.wav`);
    const cacheKey = `fill-${cue.id}`;
    let audioPath: string | null = null;
    try {
      const bytes = await readFile(file);
      wavs.set(cacheKey, bytes);
      audioPath = file;
    } catch {
      audioPath = null; // missing dir or file — text-only filler
    }
    fillers.push({
      ...cue,
      audioPath,
      audioHref: audioPath === null ? null : `/v1/audio/${cacheKey}.wav`,
    });
  }

  return { fillers, wavs };
}
