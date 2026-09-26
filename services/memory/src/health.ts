import type { FastifyInstance } from "fastify";
import { pingMongo } from "@hearthkeeper/libs";
import { loadConfig } from "./config.js";

/**
 * GET /health reports liveness plus a best-effort mongo check. Mongo being
 * down does NOT fail the request: liveness and readiness are deliberately
 * separate at scaffold stage — the process is alive and able to answer even
 * while its datastore is unreachable, so orchestration can distinguish
 * "restart the service" from "fix the database".
 */
export async function registerHealth(server: FastifyInstance): Promise<void> {
  const config = loadConfig();

  server.get("/health", async (_request, reply) => {
    const mongoUp = await pingMongo(config.MONGO_URI, 300);
    reply.code(200).send({
      status: "ok",
      service: "memory",
      checks: { mongo: mongoUp ? "up" : "down" },
    });
  });
}
