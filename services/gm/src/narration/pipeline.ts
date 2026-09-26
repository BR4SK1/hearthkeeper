/**
 * The narration pipeline: party intent in → GM prose out → beats split →
 * beats synthesized whole-utterance, strictly sequentially (synth N+1 only
 * after N completes) → beat events streamed as synthesis completes. Beat
 * extraction runs concurrently with the LLM stream: the first beat starts
 * synthesizing while later paragraphs are still generating, so
 * time-to-first-audio is bounded by (first paragraph + one synthesis), not
 * the whole reply. Fatal errors emit {"type":"error"} and reconcile the
 * machine back to idle; history is only committed on a completed stream.
 */
import type { OpenRouterClient, ChatMessage } from "../llm/openrouter.js";
import type { ChatterboxClient } from "../voice/chatterbox.js";
import type { SessionStateMachine } from "../session/machine.js";
import type { WavCache } from "../audio/cache.js";
import type { FillerWithAudio } from "../session/filler.js";
import { pickFiller } from "../session/filler.js";
import { BeatExtractor, FIRST_BEAT_MAX_CHARS } from "./split.js";
import { pcmDurationMs, wavDurationMs } from "./wav.js";
import { throwIfAborted } from "../abort.js";

export interface TurnDeps {
  llm: OpenRouterClient;
  tts: ChatterboxClient;
  machine: SessionStateMachine;
  history: ChatMessage[];
  cache: WavCache;
  fillerBank: FillerWithAudio[];
  systemPrompt: string;
  model: string;
  /** Resolved narration token cap (GM_MAX_TOKENS backstop). */
  maxTokens: number;
  /** Streamed beat synthesis (GM_TTS_STREAM) and its chunk size (GM_TTS_CHUNK_SIZE). */
  ttsStream: boolean;
  ttsChunkSize: number;
  /** Optional structured sink for the underlying fatal error (server log). */
  log?: (line: string) => void;
}

/** Distinct random seed per beat — synthesis variety; determinism not required. */
function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** Minimal async beat queue bridging the LLM stream producer and the synth consumer. */
class BeatQueue {
  private items: string[] = [];
  private closed = false;
  private failure: unknown = null;
  private waiters: Array<() => void> = [];

  push(beat: string): void {
    if (this.closed) return;
    this.items.push(beat);
    this.wake();
  }

  close(failure: unknown = null): void {
    this.closed = true;
    this.failure = failure;
    this.wake();
  }

  private wake(): void {
    for (const w of this.waiters) w();
    this.waiters = [];
  }

  /** Next beat, or null when the queue is closed and drained. Throws on stream failure. */
  async next(): Promise<string | null> {
    for (;;) {
      if (this.items.length > 0) return this.items.shift() ?? null;
      if (this.failure !== null) throw this.failure;
      if (this.closed) return null;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

export async function runTurn(
  deps: TurnDeps,
  text: string,
  send: (event: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { llm, tts, machine, history, cache, fillerBank, systemPrompt, model, ttsStream, ttsChunkSize } = deps;

  const turnId = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
  let firstBeatMs: number | null = null;
  let beatsEmitted = 0;
  let assistantText: string | null = null;

  try {
    // Conch reconciliation: boot and resets leave the session idle; a turn
    // requires the conch path to start from listening. (The busy guard in
    // the route makes stale mid-turn states impossible in practice.)
    if (machine.state === "idle") {
      machine.transition("conchTaken"); // → listening
    } else if (machine.state !== "listening") {
      machine.reset();
      machine.transition("conchTaken");
    }

    // Conch handoff: party done → acknowledge with a canned filler while
    // the GM thinks, then narrate.
    machine.transition("partyDone");
    const filler = pickFiller(fillerBank);
    send({
      type: "ack",
      filler: {
        id: filler.id,
        text: filler.text,
        audioHref: filler.audioPath === null ? null : `/v1/audio/fill-${filler.id}.wav`,
      },
    });
    machine.transition("ack"); // → thinking
    const t0 = Date.now();

    const queue = new BeatQueue();
    // Smaller first beat: measured first-synthesis latency dominates
    // time-to-first-audio.
    const extractor = new BeatExtractor({ firstBeatMaxChars: FIRST_BEAT_MAX_CHARS });

    // Producer: stream the LLM reply, queueing each completed beat as its
    // final text arrives (a paragraph is only queued once fully streamed —
    // beats are never synthesized from partial prose).
    const streaming = llm
      .chatStream(
        "narration",
        [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: text }],
        model,
        (delta) => {
          for (const beat of extractor.push(delta)) queue.push(beat);
        },
        { maxTokens: deps.maxTokens, signal },
      )
      .then((full) => {
        if (full.trim().length === 0) {
          throw new Error("openrouter completed without narration content");
        }
        for (const beat of extractor.end()) queue.push(beat);
        assistantText = full;
        queue.close();
      })
      .catch((err: unknown) => {
        queue.close(err);
      });

    // Consumer: strictly sequential synthesis — beat N+1 starts only after
    // beat N completes.
    for (let i = 0; ; i++) {
      throwIfAborted(signal);
      let beatText: string;
      try {
        const next = await queue.next();
        if (next === null) break;
        beatText = next;
      } catch (err) {
        // Stream failure surfaced through the queue: fatal path below.
        throw err;
      }
      const synthStart = Date.now();
      try {
        // Synthesis path selection (GM_TTS_STREAM): streamed headers lie —
        // placeholder data-size in the header — so the streamed path's
        // duration comes from actual PCM byte count (pcmDurationMs);
        // whole-utterance headers are correct, use wavDurationMs there.
        const synthesized = ttsStream
            ? (await tts.synthesizeStreamWithRetry(beatText, {
              chunkSize: ttsChunkSize,
              seed: randomSeed(),
            }, { signal })).buffer
          : new Uint8Array(await tts.synthesizeWithRetry(beatText, { seed: randomSeed(), signal }, { signal }));
        const id = `t${turnId}-${i}`;
        cache.put(id, Buffer.from(synthesized));
        const synthMs = Date.now() - synthStart;
        const durationMs = ttsStream
          ? pcmDurationMs(synthesized)
          : wavDurationMs(synthesized);
        if (firstBeatMs === null) {
          firstBeatMs = Date.now() - t0;
          if (machine.can("narrationStart")) machine.transition("narrationStart");
        }
        beatsEmitted++;
        send({
          type: "beat",
          i,
          turnId,
          text: beatText,
          audioHref: `/v1/audio/${id}.wav`,
          degraded: false,
          synthMs,
          durationMs: durationMs ?? null,
        });
      } catch {
        throwIfAborted(signal);
        // Non-fatal: synthesis failure degrades this beat to text-only and
        // the turn continues.
        if (firstBeatMs === null) {
          firstBeatMs = Date.now() - t0;
          if (machine.can("narrationStart")) machine.transition("narrationStart");
        }
        beatsEmitted++;
        send({
          type: "beat",
          i,
          turnId,
          text: beatText,
          audioHref: null,
          degraded: true,
          synthMs: Date.now() - synthStart,
          durationMs: null,
        });
      }
    }

    throwIfAborted(signal);
    machine.transition("narrationEnd"); // → listening
    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: assistantText ?? "" });

    send({
      type: "done",
      turnId,
      firstBeatMs,
      totalMs: Date.now() - t0,
      beats: beatsEmitted,
    });
    void streaming; // settled — its result was consumed via the queue
  } catch (err) {
    // Fatal path: the spec requires error-then-close, and the history must
    // not be corrupted with a partial reply. Reconcile the machine so the
    // next turn can start. Log the underlying cause (the wire event stays
    // generic and story-shaped).
    deps.log?.("[gm] turn failed: " + (err instanceof Error ? err.message : String(err)));
    if (!signal?.aborted) {
      send({
        type: "error",
        message: "the gm could not complete the turn; the story holds — try again",
      });
    }
    machine.reset();
  }
}
