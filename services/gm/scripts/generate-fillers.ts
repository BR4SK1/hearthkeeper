/**
 * One-shot generator for the pre-rendered filler wavs: synthesizes each
 * FILLER_BANK cue whole-utterance via a configured Chatterbox-compatible TTS
 * service and writes assets/fillers/<id>.wav. Run with tsx against that service.
 * service. Exits non-zero with a clear message on any failure — wavs are
 * never faked.
 *
 *   pnpm --filter @hearthkeeper/service-gm exec tsx scripts/generate-fillers.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChatterboxClient, ChatterboxColdStartError, ChatterboxRequestError } from "../src/voice/chatterbox.js";
import { FILLER_BANK } from "../src/session/filler.js";
import { wavDurationMs } from "../src/narration/wav.js";

const baseUrl = process.env.CHATTERBOX_BASE_URL ?? "http://localhost:8000";
const voiceMode = process.env.CHATTERBOX_VOICE_MODE ?? "clone";
const referenceAudioFilename = process.env.CHATTERBOX_REFERENCE_AUDIO ?? "reference.wav";
const outDir = join(import.meta.dirname ?? ".", "..", "assets", "fillers");

async function main(): Promise<void> {
  const tts = new ChatterboxClient({ baseUrl, voiceMode, referenceAudioFilename });
  await mkdir(outDir, { recursive: true });

  for (const cue of FILLER_BANK) {
    try {
      const buffer = await tts.synthesizeWithRetry(cue.text);
      const bytes = new Uint8Array(buffer);
      const file = join(outDir, `${cue.id}.wav`);
      await writeFile(file, bytes);
      const durationMs = wavDurationMs(bytes);
      // eslint-disable-next-line no-console
      console.log(
        `${cue.id}  ${bytes.length} bytes  ${durationMs === null ? "unknown duration" : `${Math.round(durationMs)} ms`}  -> ${file}`,
      );
    } catch (err) {
      const reason =
        err instanceof ChatterboxColdStartError
          ? "chatterbox cold start (503) after exhausting retries"
          : err instanceof ChatterboxRequestError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
      // eslint-disable-next-line no-console
      console.error(`FAILED ${cue.id}: ${reason}`);
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("filler generation failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
