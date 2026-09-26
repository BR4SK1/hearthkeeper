import type { FastifyInstance, FastifyReply } from "fastify";
import { ChatterboxClient } from "./voice/chatterbox.js";
import { loadConfig } from "./config.js";

/**
 * GET /health never fails the request: openrouter key state and chatterbox
 * reachability are reported as checks, not as liveness. The process is alive
 * whether or not its dependencies are — orchestration decides readiness from
 * the check values.
 */
export async function registerHealth(server: FastifyInstance): Promise<void> {
  const config = loadConfig();
  const chatterbox = new ChatterboxClient({
    baseUrl: config.CHATTERBOX_BASE_URL,
    voiceMode: config.CHATTERBOX_VOICE_MODE,
    referenceAudioFilename: config.CHATTERBOX_REFERENCE_AUDIO,
  });

  const healthHandler = async (_request: unknown, reply: FastifyReply): Promise<void> => {
    const openRouter = config.OPENROUTER_API_KEY ? "configured" : "missing-key";

    let chatterboxState: "reachable" | "unreachable" = "unreachable";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      // Probe /api/model-info (the deployed service has no /health) with a
      // 500 ms timeout; any error, including abort, means unreachable.
      await Promise.race([
        chatterbox.modelInfo(),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(new Error("chatterbox probe timed out")),
          );
        }),
      ]);
      chatterboxState = "reachable";
    } catch {
      chatterboxState = "unreachable";
    } finally {
      clearTimeout(timer);
    }

    reply.code(200).send({
      status: "ok",
      service: "gm",
      checks: { openRouter, chatterbox: chatterboxState },
    });
  };

  server.get("/health", healthHandler);

  // /v1/health alias: the ingress routes /v1/* to gm, so the deployed
  // ingress 404s /health while /v1/health answers — with the alias both
  // forms work through any path rule. Same handler, same shape.
  server.get("/v1/health", healthHandler);
}
