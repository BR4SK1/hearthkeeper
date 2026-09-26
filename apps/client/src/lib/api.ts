/**
 * Client side of the gm wire contract: POST /v1/turn streams NDJSON events
 * (ack → beats → done, or error) as chunked lines; GET-audio and session
 * reset round it out. No auth — this is the LAN campfire.
 */
import { GM_BASE_URL } from "./config";
import { createNdjsonLineSplitter, parseNdjsonEvent } from "./ndjson";

export type TurnEvent =
  | {
      type: "ack";
      filler: { id: string; text: string; audioHref: string | null };
    }
  | {
      type: "beat";
      i: number;
      turnId: string;
      text: string;
      audioHref: string | null;
      degraded: boolean;
      synthMs: number;
      durationMs: number | null;
    }
  | {
      type: "done";
      turnId: string;
      firstBeatMs: number | null;
      totalMs: number;
      beats: number;
    }
  | { type: "error"; message: string };

/**
 * POST one turn and dispatch each NDJSON event to onEvent in arrival order.
 * Resolves when the stream closes; throws on non-2xx (409 → the friendly
 * busy message) or a missing body. signal aborts the fetch.
 */
export async function postTurn(
  text: string,
  onEvent: (event: TurnEvent) => void,
  opts: { signal?: AbortSignal; baseUrl?: string } = {},
): Promise<void> {
  const base = opts.baseUrl ?? GM_BASE_URL;
  const response = await fetch(`${base}/v1/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: opts.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 409) {
      throw new Error("gm is already narrating");
    }
    throw new Error(
      `gm turn failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
    );
  }
  if (!response.body) {
    throw new Error("gm turn stream returned no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const nextLines = createNdjsonLineSplitter();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of nextLines(decoder.decode(value, { stream: true }))) {
        onEvent(parseNdjsonEvent<TurnEvent>(line));
      }
    }
    // End of stream: flush any trailing partial line.
    for (const line of nextLines(`${decoder.decode()}\n`)) {
      onEvent(parseNdjsonEvent<TurnEvent>(line));
    }
  } finally {
    reader.releaseLock();
  }
}

/** Clear the gm conversation history (a fresh scene at the campfire). */
export async function resetSession(opts: { baseUrl?: string } = {}): Promise<void> {
  const base = opts.baseUrl ?? GM_BASE_URL;
  const response = await fetch(`${base}/v1/session/reset`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`gm session reset failed: HTTP ${response.status}`);
  }
}