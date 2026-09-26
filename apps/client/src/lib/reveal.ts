/**
 * Reveal pacing (settled §5): beat text reveals progressively in sync with
 * the audio's pace, with a text-pace fallback (≈16 chars/sec) when the
 * audio duration is unknown. Pure functions; monotonicity across frames is
 * the caller's job (elapsed only grows), and results are stable for equal
 * inputs.
 */
import type { DisplaySegment } from "./paralinguistic";

const DEFAULT_CPS = 16;

/**
 * Playback truth for a beat's duration: the server-provided PCM duration
 * first (computed from actual bytes — streamed WAV headers carry a
 * placeholder data-size, so never derive pacing from the header), else a
 * FINITE positive audioDuration (element metadata), else null (→ text-pace
 * fallback).
 */
export function resolveBeatDuration(opts: {
  durationMs?: number | null;
  audioDuration?: number | null;
}): number | null {
  if (opts.durationMs != null && opts.durationMs > 0) return opts.durationMs;
  if (
    opts.audioDuration != null &&
    Number.isFinite(opts.audioDuration) &&
    opts.audioDuration > 0
  ) {
    return opts.audioDuration;
  }
  return null;
}

/**
 * How many characters of a beat are visible after elapsedMs. Audio mode
 * (durationMs given): proportional to elapsed/duration; text mode: linear
 * at cps. Both clamp to [0, total].
 */
export function charsVisible(
  elapsedMs: number,
  opts: { total: number; durationMs?: number | null; cps?: number },
): number {
  const { total, durationMs, cps } = opts;
  if (total <= 0) return 0;
  const elapsed = Math.max(0, elapsedMs);
  if (durationMs != null && durationMs > 0) {
    const fraction = Math.min(1, elapsed / durationMs);
    return Math.min(total, Math.floor(total * fraction));
  }
  const rate = (cps ?? DEFAULT_CPS) / 1000; // chars per ms
  return Math.min(total, Math.floor(elapsed * rate));
}

/**
 * The revealed prefix of a beat's display segments: text segments truncate
 * to the remaining budget; a tag segment appears only once the cursor
 * reaches its start offset and costs a fixed 1 char (so it shows up near
 * its position in the prose instead of being skipped or delaying it).
 */
export function tagAwareReveal(
  segments: DisplaySegment[],
  visibleChars: number,
): DisplaySegment[] {
  const revealed: DisplaySegment[] = [];
  let budget = Math.max(0, Math.floor(visibleChars));
  for (const segment of segments) {
    if (budget <= 0) break;
    if (segment.type === "text") {
      if (segment.value.length <= budget) {
        revealed.push(segment);
        budget -= segment.value.length;
      } else {
        revealed.push({ type: "text", value: segment.value.slice(0, budget) });
        budget = 0;
      }
    } else {
      revealed.push(segment);
      budget -= 1;
    }
  }
  return revealed;
}