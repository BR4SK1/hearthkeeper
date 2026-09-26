import type { DisplaySegment } from "./paralinguistic.js";

export interface BeatState {
  segments: DisplaySegment[];
  revealed: number;
  degraded: boolean;
}

export type LogEntry =
  | { kind: "party"; text: string }
  | { kind: "gm"; turnId: string; beats: BeatState[] }
  | { kind: "filler"; text: string };

export function appendTurnBeat(log: LogEntry[], turnId: string, beat: BeatState): LogEntry[] {
  const index = log.findIndex((entry) => entry.kind === "gm" && entry.turnId === turnId);
  if (index === -1) return [...log, { kind: "gm", turnId, beats: [beat] }];
  const entry = log[index];
  if (entry.kind !== "gm") return log;
  const next = [...log];
  next[index] = { kind: "gm", turnId, beats: [...entry.beats, beat] };
  return next;
}

export function updateTurnBeat(
  log: LogEntry[],
  turnId: string,
  beatIndex: number,
  patch: Partial<BeatState>,
): LogEntry[] {
  const index = log.findIndex((entry) => entry.kind === "gm" && entry.turnId === turnId);
  if (index === -1) return log;
  const entry = log[index];
  if (entry.kind !== "gm" || entry.beats[beatIndex] === undefined) return log;
  const next = [...log];
  const beats = [...entry.beats];
  beats[beatIndex] = { ...beats[beatIndex], ...patch };
  next[index] = { kind: "gm", turnId, beats };
  return next;
}
