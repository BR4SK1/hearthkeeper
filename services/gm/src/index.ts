import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import type { GmConfig } from "./config.js";
import { registerHealth } from "./health.js";
import { SessionStateMachine } from "./session/machine.js";
import { loadFillerBank } from "./session/filler.js";
import { OpenRouterClient } from "./llm/openrouter.js";
import { gmSystemPrompt, DEFAULT_PREMISE } from "./llm/prompts.js";
import { ChatterboxClient } from "./voice/chatterbox.js";
import { WavCache } from "./audio/cache.js";
import { registerTurnRoute } from "./routes/turn.js";
import { registerAudioRoute } from "./routes/audio.js";
import { registerSessionRoutes } from "./routes/session.js";
import type { TurnDeps } from "./narration/pipeline.js";

/**
 * hearthkeeper GM orchestration service. The deployable slice: a party's
 * typed intent comes in on POST /v1/turn, the GM (OpenRouter) answers in
 * spoken prose, the prose is split into narration beats, each beat is
 * synthesized whole-utterance by Chatterbox, and beats stream to the
 * client as they complete. Memory domain integration is a later slice.
 */

export interface ServerDeps extends TurnDeps {
  busyFlag: { inFlight: boolean };
}

export async function buildServer(
  overrides: Partial<
    Omit<ServerDeps, "llm" | "tts" | "fillerBank"> & {
      llm?: ServerDeps["llm"];
      tts?: ServerDeps["tts"];
      fillerBank?: ServerDeps["fillerBank"];
      fillerAssetsDir?: string;
    }
  > = {},
): Promise<FastifyInstance> {
  const config: GmConfig = loadConfig();
  const machine = overrides.machine ?? new SessionStateMachine();
  const history = overrides.history ?? [];
  const cache = overrides.cache ?? new WavCache();

  // Filler wavs load at boot; a missing assets dir degrades to text-only
  // fillers (audioHref null in the ack event) — never a boot failure.
  const loaded = await loadFillerBank(overrides.fillerAssetsDir ?? config.FILLER_ASSETS_DIR);
  for (const [key, wav] of loaded.wavs) cache.put(key, wav);

  const deps: ServerDeps = {
    llm:
      overrides.llm ??
      new OpenRouterClient({
        apiKey: config.OPENROUTER_API_KEY,
        referer: `http://localhost:${config.GM_PORT}`,
        timeoutMs: config.GM_LLM_TIMEOUT_MS,
      }),
      tts:
        overrides.tts ??
        new ChatterboxClient({
          baseUrl: config.CHATTERBOX_BASE_URL,
          voiceMode: config.CHATTERBOX_VOICE_MODE,
          referenceAudioFilename: config.CHATTERBOX_REFERENCE_AUDIO,
        }, undefined, config.GM_TTS_TIMEOUT_MS),
    machine,
    history,
    cache,
    fillerBank: overrides.fillerBank ?? loaded.fillers,
    systemPrompt:
      overrides.systemPrompt ?? gmSystemPrompt(config.GM_PREMISE || DEFAULT_PREMISE, config.GM_TURN_LENGTH),
    model: overrides.model ?? config.OPENROUTER_MODEL,
    maxTokens: overrides.maxTokens ?? config.GM_MAX_TOKENS,
    ttsStream: overrides.ttsStream ?? config.GM_TTS_STREAM,
    ttsChunkSize: overrides.ttsChunkSize ?? config.GM_TTS_CHUNK_SIZE,
    busyFlag: overrides.busyFlag ?? { inFlight: false },
  };

  const server = Fastify({ logger: true });

  await registerHealth(server);
  registerTurnRoute(server, deps);
  registerAudioRoute(server, deps.cache);
  registerSessionRoutes(server, deps);

  return server;
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const server = await buildServer();

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, "shutting down");
    try {
      await server.close();
      process.exit(0);
    } catch (err) {
      server.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.listen({ host: config.HOST, port: config.GM_PORT });
}

// Autostart only when this file is the process entry point; imports under
// vitest or as a module must not bind a port.
const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("gm service failed to start:", err);
    process.exit(1);
  });
}
