import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../index.js";
import { SessionStateMachine } from "../session/machine.js";
import { WavCache } from "../audio/cache.js";
import type { FillerWithAudio } from "../session/filler.js";
import { FILLER_BANK } from "../session/filler.js";
import type { ChatMessage, OpenRouterClient } from "../llm/openrouter.js";
import type { ChatterboxClient } from "../voice/chatterbox.js";
import { makeWavBytes } from "../narration/wav.testutil.js";

const fillers: FillerWithAudio[] = FILLER_BANK.map((cue) => ({ ...cue, audioPath: null, audioHref: null }));

const WAV = makeWavBytes(24000, 1, 16, 2400);

interface Gate {
  open: () => void;
  promise: Promise<void>;
}

function makeGate(): Gate {
  let release: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { open: () => release?.(), promise };
}

/** LLM stub: streams one paragraph immediately, then holds the stream open until the gate releases. */
function gatedLlm(): { llm: OpenRouterClient; gate: Gate } {
  const gate = makeGate();
  const llm = {
    chatStream: async (
      _task: string,
      _messages: ChatMessage[],
      _model: string,
      onDelta?: (delta: string) => void,
    ): Promise<string> => {
      onDelta?.("One paragraph of narration, done.\n");
      await gate.promise;
      return "One paragraph of narration, done.";
    },
  } as unknown as OpenRouterClient;
  return { llm: llm as OpenRouterClient, gate };
}

/** TTS stub: synthesis completes only when the gate releases. */
function gatedTts(): { tts: ChatterboxClient; gate: Gate } {
  const gate = makeGate();
  const tts = {
    synthesizeWithRetry: async (_text: string): Promise<ArrayBuffer> => {
      await gate.promise;
      return WAV.slice().buffer as ArrayBuffer;
    },
  } as unknown as ChatterboxClient;
  return { tts: tts as ChatterboxClient, gate };
}

const fastTts = (): { tts: ChatterboxClient } => ({
  tts: {
    synthesizeWithRetry: async (): Promise<ArrayBuffer> => WAV.slice().buffer as ArrayBuffer,
  } as unknown as ChatterboxClient,
});

const fastLlm = (): { llm: OpenRouterClient } => ({
  llm: {
    chatStream: async (
      _task: string,
      _messages: ChatMessage[],
      _model: string,
      onDelta?: (delta: string) => void,
    ): Promise<string> => {
      onDelta?.("One paragraph of narration, done.\n");
      return "One paragraph of narration, done.";
    },
  } as unknown as OpenRouterClient,
});

let servers: Array<Awaited<ReturnType<typeof buildServer>>> = [];
const build = async (
  overrides: Parameters<typeof buildServer>[0] = {},
): Promise<Awaited<ReturnType<typeof buildServer>>> => {
  const server = await buildServer({ fillerBank: fillers, ttsStream: false, ...overrides });
  servers.push(server);
  return server;
};

describe("turn + audio + session routes (buildServer with stub deps)", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it("rejects an empty body with 400", async () => {
    const server = await build({ llm: fastLlm().llm, tts: fastTts().tts });
    const res = await server.inject({ method: "POST", url: "/v1/turn", payload: { text: "" } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing body with 400", async () => {
    const server = await build({ llm: fastLlm().llm, tts: fastTts().tts });
    const res = await server.inject({ method: "POST", url: "/v1/turn" });
    expect(res.statusCode).toBe(400);
  });

  it("streams the NDJSON contract in order and serves beat audio", async () => {
    const server = await build({ llm: fastLlm().llm, tts: fastTts().tts });

    const res = await server.inject({
      method: "POST",
      url: "/v1/turn",
      payload: { text: "we case the diner" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-accel-buffering"]).toBe("no");

    const events = res.body
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; i?: number; audioHref?: string });

    expect(events.map((e) => e.type)).toEqual(["ack", "beat", "done"]);
    expect(events[1]?.i).toBe(0);

    // Beat audio is fetchable (the .wav suffix is stripped before lookup);
    // unknown ids 404 with the contract body.
    const beatHref = events[1]?.audioHref ?? "";
    expect(beatHref).toMatch(/^\/v1\/audio\/t[0-9a-z]+-0\.wav$/);
    const audio = await server.inject({ method: "GET", url: beatHref });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers["content-type"]).toContain("audio/wav");

    const missing = await server.inject({ method: "GET", url: "/v1/audio/tunknown-9.wav" });
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body)).toEqual({ error: "not found" });
  });

  it("returns 409 for a second turn while one is in flight", async () => {
    const { llm, gate: llmGate } = gatedLlm();
    const { tts, gate: ttsGate } = gatedTts(); // TTS holds the turn busy
    const server = await build({ llm, tts });

    const first = server.inject({ method: "POST", url: "/v1/turn", payload: { text: "first intent" } });

    // Wait until the first turn is actually in flight (status.busy flips).
    let busy = false;
    for (let i = 0; i < 100 && !busy; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const status = await server.inject({ method: "GET", url: "/v1/session/status" });
      busy = (JSON.parse(status.body) as { busy: boolean }).busy;
    }
    expect(busy).toBe(true);

    const second = await server.inject({ method: "POST", url: "/v1/turn", payload: { text: "second intent" } });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body)).toEqual({ error: "gm is already narrating" });

    const reset = await server.inject({ method: "POST", url: "/v1/session/reset" });
    expect(reset.statusCode).toBe(409);
    expect(JSON.parse(reset.body)).toEqual({ error: "cannot reset while gm is narrating" });

    // Release the gated stubs so the first turn completes and closes.
    llmGate.open();
    ttsGate.open();

    const firstBody = await first;
    expect(firstBody.statusCode).toBe(200);
    const types = firstBody.body
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toEqual(["ack", "beat", "done"]);
    expect(JSON.parse(lastLine(firstBody.body)).turnId).toBeTruthy();
  });

  it("resets history without touching the machine", async () => {
    const server = await build({ llm: fastLlm().llm, tts: fastTts().tts });
    const res = await server.inject({ method: "POST", url: "/v1/session/reset" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    const status = await server.inject({ method: "GET", url: "/v1/session/status" });
    expect(JSON.parse(status.body)).toMatchObject({ state: "idle", busy: false, turns: 0 });
  });

  it("serves /v1/health with the same shape as /health (ingress alias)", async () => {
    const server = await build({ llm: fastLlm().llm, tts: fastTts().tts });
    const root = await server.inject({ method: "GET", url: "/health" });
    const alias = await server.inject({ method: "GET", url: "/v1/health" });
    expect(alias.statusCode).toBe(200);
    expect(JSON.parse(alias.body)).toEqual(JSON.parse(root.body));
    expect(JSON.parse(alias.body)).toMatchObject({ status: "ok", service: "gm" });
  });
});

function lastLine(body: string): string {
  const lines = body.split("\n").filter((l) => l.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}
