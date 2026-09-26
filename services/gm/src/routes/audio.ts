/**
 * GET /v1/audio/:id — serve a cached wav as audio/wav; 404 on unknown or
 * evicted ids. Cache keys are the bare ids the contract names
 * ("fill-<fillerId>", "t<turnId>-<i>"); hrefs on the wire carry a ".wav"
 * suffix, which is stripped here before lookup.
 */
import type { FastifyInstance } from "fastify";
import type { WavCache } from "../audio/cache.js";

export function registerAudioRoute(server: FastifyInstance, cache: WavCache): void {
  server.get("/v1/audio/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const key = id.endsWith(".wav") ? id.slice(0, -".wav".length) : id;
    const wav = cache.get(key);
    if (wav === undefined) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.type("audio/wav").send(wav);
  });
}
