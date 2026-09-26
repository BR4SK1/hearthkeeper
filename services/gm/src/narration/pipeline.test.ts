import { describe, expect, it } from "vitest";
import type { ChatMessage, OpenRouterClient } from "../llm/openrouter.js";
import type { ChatterboxClient } from "../voice/chatterbox.js";
import { SessionStateMachine } from "../session/machine.js";
import { WavCache } from "../audio/cache.js";
import type { FillerWithAudio } from "../session/filler.js";
import { FILLER_BANK } from "../session/filler.js";
import { runTurn } from "./pipeline.js";
import { makeWavBytes } from "./wav.testutil.js";

const fillers: FillerWithAudio[] = FILLER_BANK.map((cue) => ({
  ...cue,
  // Every filler has audio (as when the assets dir exists): the ack event
  // must then expose the .wav href the audio route serves.
  audioPath: `/fake/assets/fill-${cue.id}.wav`,
  audioHref: null,
}));

interface FakeLlm {
  llm: OpenRouterClient;
  script: (onDelta: (delta: string) => void) => Promise<string>;
  calls: Array<{ messages: ChatMessage[]; model: string }>;
}

function fakeLlm(script: FakeLlm["script"]): FakeLlm {
  const calls: Array<{ messages: ChatMessage[]; model: string }> = [];
  const llm = {
    chatStream: async (
      _task: string,
      messages: ChatMessage[],
      model: string,
      onDelta?: (delta: string) => void,
    ): Promise<string> => {
      calls.push({ messages, model });
      return script((delta) => onDelta?.(delta));
    },
  } as unknown as OpenRouterClient;
  return { llm, script, calls };
}

function fakeTts(
  behavior: (text: string) => Promise<ArrayBuffer>,
): { tts: ChatterboxClient; texts: string[] } {
  const texts: string[] = [];
  const tts = {
    synthesizeWithRetry: async (text: string): Promise<ArrayBuffer> => {
      texts.push(text);
      return behavior(text);
    },
  } as unknown as ChatterboxClient;
  return { tts, texts };
}

function baseDeps(llm: OpenRouterClient, tts: ChatterboxClient): {
  deps: Parameters<typeof runTurn>[0];
  machine: SessionStateMachine;
  history: ChatMessage[];
  cache: WavCache;
} {
  const machine = new SessionStateMachine();
  const history: ChatMessage[] = [];
  const cache = new WavCache();
  return {
    machine,
    history,
    cache,
    deps: {
      llm,
      tts,
      machine,
      history,
      cache,
      fillerBank: fillers,
      systemPrompt: "system-prompt-for-test",
      model: "model-x",
      maxTokens: 700,
      ttsStream: false,
      ttsChunkSize: 100,
    },
  };
}

const THREE_BEATS = [
  "First beat ends here.\n",
  "Second beat follows the first.\n",
  "Third beat closes the reply.",
].join("");

describe("runTurn", () => {
  it("streams ack → beats → done in order, caches audio, updates history, returns machine to listening", async () => {
    const wav = makeWavBytes(24000, 1, 16, 2400); // 100ms of audio
    const { llm } = fakeLlm(async (onDelta) => {
      onDelta(THREE_BEATS);
      return THREE_BEATS;
    });
    const { tts, texts } = fakeTts(async () => wav.slice().buffer as ArrayBuffer);
    const { deps, machine, history, cache } = baseDeps(llm, tts);

    const events: unknown[] = [];
    await runTurn(deps, "we case the warehouse", (event) => events.push(event));

    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toEqual(["ack", "beat", "beat", "beat", "done"]);

    const ack = events[0] as { filler: { id: string; audioHref: string | null } };
    expect(ack.filler.audioHref).toBe(`/v1/audio/fill-${ack.filler.id}.wav`);

    const beat0 = events[1] as { i: number; audioHref: string; degraded: boolean; durationMs: number };
    expect(beat0.i).toBe(0);
    expect(beat0.degraded).toBe(false);
    expect(beat0.audioHref).toMatch(/^\/v1\/audio\/t[0-9a-z]+-0\.wav$/);
    expect(beat0.durationMs).toBeCloseTo(100, 0);

    const done = events[4] as { beats: number; firstBeatMs: number | null; totalMs: number };
    expect(done.beats).toBe(3);
    expect(done.firstBeatMs).not.toBeNull();
    expect(typeof done.totalMs).toBe("number");

    // Beats synthesized in order, whole-utterance.
    expect(texts).toEqual([
      "First beat ends here.",
      "Second beat follows the first.",
      "Third beat closes the reply.",
    ]);

    // History committed: user + assistant.
    expect(history).toEqual([
      { role: "user", content: "we case the warehouse" },
      { role: "assistant", content: THREE_BEATS },
    ]);

    // Machine back to listening; audio cached under the emitted href id
    // (the .wav suffix is a wire decoration, stripped before lookup).
    expect(machine.state).toBe("listening");
    const beat0Key = (events[1] as { audioHref: string })
      .audioHref.replace("/v1/audio/", "")
      .replace(/\.wav$/, "");
    expect(cache.has(beat0Key)).toBe(true);
  });

  it("degrades failed beats to text-only and still completes the turn", async () => {
    const { llm } = fakeLlm(async (onDelta) => {
      onDelta("Beat one.\nBeat two.\n");
      return "Beat one.\nBeat two.";
    });
    const { tts } = fakeTts(async () => {
      throw new Error("synthesis exploded");
    });
    const { deps, machine, history } = baseDeps(llm, tts);

    const events: unknown[] = [];
    await runTurn(deps, "intent", (event) => events.push(event));

    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toEqual(["ack", "beat", "beat", "done"]);

    const beats = events.filter((e) => (e as { type: string }).type === "beat") as Array<{
      degraded: boolean;
      audioHref: string | null;
    }>;
    for (const beat of beats) {
      expect(beat.degraded).toBe(true);
      expect(beat.audioHref).toBeNull();
    }
    const done = events[3] as { beats: number };
    expect(done.beats).toBe(2); // degraded beats still count
    expect(machine.state).toBe("listening");
    expect(history).toHaveLength(2); // user + assistant still committed
  });

  it("emits error on LLM failure, machine returns to a restartable state, history untouched", async () => {
    const { llm } = fakeLlm(async () => {
      throw new Error("openrouter unreachable");
    });
    const { tts, texts } = fakeTts(async () => new ArrayBuffer(8));
    const { deps, machine, history } = baseDeps(llm, tts);

    const events: unknown[] = [];
    await runTurn(deps, "intent", (event) => events.push(event));

    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toEqual(["ack", "error"]);
    expect((events[1] as { message: string }).message).toBeTruthy();

    expect(texts).toEqual([]); // no beats were queued before the failure
    expect(history).toHaveLength(0); // NOT corrupted with a partial reply

    // The machine reconciles so the next turn can start (idle → conchTaken works).
    machine.transition("conchTaken");
    expect(machine.state).toBe("listening");
  });

  it("emits beats with no artificial inter-beat delay (synth-paced, RTF < 1)", async () => {
    // Playback-gap verification: when synthesis is faster than playback
    // (RTF < 1), each beat's event must fire as soon as its synthesis
    // completes — emission gap between consecutive beats ≈ the next
    // beat's synthesis time, never padded by the server.
    const synthMs = [400, 600, 500];
    const durationMs = [2000, 2000, 2000];
    let synthCall = 0;
    const tts = {
      synthesizeWithRetry: async (): Promise<ArrayBuffer> => {
        const i = Math.min(synthCall, synthMs.length - 1);
        const samples = Math.round((durationMs[i] / 1000) * 24000);
        const ms = synthMs[i] ?? synthMs[synthMs.length - 1];
        synthCall++;
        await new Promise((r) => setTimeout(r, ms));
        return makeWavBytes(24000, 1, 16, samples).slice().buffer as ArrayBuffer;
      },
    } as unknown as ChatterboxClient;

    const beats = ["Beat one here.\n", "Beat two follows.\n", "Beat three closes."];
    const { llm } = fakeLlm(async (onDelta) => {
      for (const beat of beats) onDelta(beat);
      return beats.join("");
    });
    const { deps, machine } = baseDeps(llm, tts);

    const emittedAt: Record<string, number> = {};
    await runTurn(deps, "intent", (event) => {
      const type = (event as { type: string }).type;
      if (type === "beat" || type === "ack" || type === "done") {
        const i = (event as { i?: number }).i;
        emittedAt[i === undefined ? type : `${type}-${i}`] = Date.now();
      }
    });

    const types = Object.keys(emittedAt).sort();
    expect(types).toEqual(["ack", "beat-0", "beat-1", "beat-2", "done"]);

    const gap01 = emittedAt["beat-1"] - emittedAt["beat-0"];
    const gap12 = emittedAt["beat-2"] - emittedAt["beat-1"];
    expect(Math.abs(gap01 - synthMs[1])).toBeLessThanOrEqual(150);
    expect(Math.abs(gap12 - synthMs[2])).toBeLessThanOrEqual(150);

    // Done arrives right after the last beat (only stream teardown work).
    expect(emittedAt["done"] - emittedAt["beat-2"]).toBeLessThanOrEqual(150);
    expect(machine.state).toBe("listening");
  });

  it("synthesizes and emits a completed sentence while the LLM stream is still open", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let llmFinished = false;
    const llm = {
      chatStream: async (
        _task: string,
        _messages: ChatMessage[],
        _model: string,
        onDelta?: (delta: string) => void,
      ): Promise<string> => {
        onDelta?.("The alley goes quiet. ");
        await gate;
        llmFinished = true;
        return "The alley goes quiet.";
      },
    } as unknown as OpenRouterClient;
    const wav = makeWavBytes(24000, 1, 16, 2400);
    const { tts } = fakeTts(async () => wav.slice().buffer as ArrayBuffer);
    const { deps } = baseDeps(llm, tts);
    const events: Array<{ type: string }> = [];
    let turnFinished = false;
    const pending = runTurn(deps, "listen", (event) => {
      events.push(event as { type: string });
    }).then(() => { turnFinished = true; });

    for (let attempt = 0; attempt < 100 && !events.some((event) => event.type === "beat"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(events.map((event) => event.type)).toContain("beat");
    expect(llmFinished).toBe(false);
    expect(turnFinished).toBe(false);

    release();
    await pending;
    expect(llmFinished).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("cancels synthesis without committing a partial turn to history", async () => {
    const controller = new AbortController();
    const { llm } = fakeLlm(async (onDelta) => {
      onDelta("The first sentence is ready. ");
      return "The first sentence is ready.";
    });
    const tts = {
      synthesizeWithRetry: async (_text: string, opts: { signal?: AbortSignal }): Promise<ArrayBuffer> =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
          controller.abort(new DOMException("cancelled", "AbortError"));
        }),
    } as unknown as ChatterboxClient;
    const { deps, machine, history } = baseDeps(llm, tts);
    const events: Array<{ type: string }> = [];

    await runTurn(deps, "intent", (event) => events.push(event as { type: string }), controller.signal);

    expect(events.map((event) => event.type)).toEqual(["ack"]);
    expect(history).toHaveLength(0);
    expect(machine.state).toBe("idle");
  });

  it("uses streamed synthesis when enabled and reports PCM-true durations", async () => {
    // Build a truthful 2s wav, then LIE in the header like chatterbox's
    // streaming mode (placeholder data-size): the beat event must carry the
    // PCM-derived duration, not the header's.
    const truthful = makeWavBytes(24000, 1, 16, 48000); // 2s
    const placeholder = truthful.slice();
    const pv = new DataView(placeholder.buffer);
    pv.setUint32(40, 8, true);

    let streamCalls = 0;
    let wholeCalls = 0;
    const streamOpts: { value: { chunkSize?: number; seed?: number } | null } = { value: null };
    const tts = {
      synthesizeStreamWithRetry: async (
        _text: string,
        opts: { chunkSize?: number; seed?: number } = {},
      ): Promise<{ buffer: Uint8Array; durationMs: number | null }> => {
        streamCalls++;
        streamOpts.value = opts;
        return { buffer: placeholder, durationMs: 2000 };
      },
      synthesizeWithRetry: async (): Promise<ArrayBuffer> => {
        wholeCalls++;
        return truthful.slice().buffer as ArrayBuffer;
      },
    } as unknown as ChatterboxClient;

    const { llm } = fakeLlm(async (onDelta) => {
      onDelta("Streamed beat one.\nStreamed beat two.");
      return "Streamed beat one.\nStreamed beat two.";
    });
    const { deps, machine, history } = baseDeps(llm, tts);
    const streamedDeps = { ...deps, ttsStream: true, ttsChunkSize: 100 };

    const events: unknown[] = [];
    await runTurn(streamedDeps, "intent", (event) => events.push(event));

    const beats = events.filter((e) => (e as { type: string }).type === "beat") as Array<{
      durationMs: number | null;
      degraded: boolean;
    }>;
    expect(beats).toHaveLength(2);
    for (const beat of beats) {
      expect(beat.durationMs).toBeCloseTo(2000, 0); // PCM-derived, not the header's 8
      expect(beat.degraded).toBe(false);
    }
    expect(streamCalls).toBe(2);
    expect(wholeCalls).toBe(0);
    expect(streamOpts.value?.chunkSize).toBe(100); // config chunk size threads through
    expect(machine.state).toBe("listening");
    expect(history).toHaveLength(2);
  });

  it("falls back to whole-utterance synthesis when the stream flag is off", async () => {
    const truthful = makeWavBytes(24000, 1, 16, 24000); // 1s, truthful header
    let streamCalls = 0;
    let wholeCalls = 0;
    const tts = {
      synthesizeStreamWithRetry: async (): Promise<unknown> => {
        streamCalls++;
        throw new Error("stream path must not be used");
      },
      synthesizeWithRetry: async (): Promise<ArrayBuffer> => {
        wholeCalls++;
        return truthful.slice().buffer as ArrayBuffer;
      },
    } as unknown as ChatterboxClient;

    const { llm } = fakeLlm(async (onDelta) => {
      onDelta("One whole-utterance beat.\nAnd another.");
      return "One whole-utterance beat.\nAnd another.";
    });
    const { deps, machine } = baseDeps(llm, tts);
    const wholeDeps = { ...deps, ttsStream: false, ttsChunkSize: 100 };

    const events: unknown[] = [];
    await runTurn(wholeDeps, "intent", (event) => events.push(event));

    const beats = events.filter((e) => (e as { type: string }).type === "beat") as Array<{
      durationMs: number | null;
    }>;
    expect(beats).toHaveLength(2);
    expect(beats[0].durationMs).toBeCloseTo(1000, 0); // header-derived (truthful)
    expect(streamCalls).toBe(0);
    expect(wholeCalls).toBe(2);
    expect(machine.state).toBe("listening");
  });
});
