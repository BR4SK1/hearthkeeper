/*
 * hearthkeeper campaign memory — module boundaries anticipate future
 * (campaign-scoped canonical observations, watermark-based async ingest,
 * no-LLM recall, gated recaps), adapted from the ai-companion memory
 * architecture per the user's explicit reuse direction.
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { closeMongo, getDb } from "@hearthkeeper/libs";
import { loadConfig } from "./config.js";
import { registerHealth } from "./health.js";
import { ensureIndexes } from "./db/ensureIndexes.js";

export async function buildServer(): Promise<FastifyInstance> {
  const config = loadConfig();
  const server = Fastify({ logger: true });

  await registerHealth(server);

  if (config.MONGO_ENSURE_INDEXES) {
    try {
      const db = await getDb(config.MONGO_URI, config.MONGO_DB);
      await ensureIndexes(db);
      server.log.info("mongo index bootstrap complete");
    } catch (err) {
      // Index bootstrap is non-fatal: the service must boot with mongo down
      // (health reports the outage; the next boot retries the bootstrap).
      server.log.warn({ err }, "mongo index bootstrap failed (non-fatal)");
    }
  }

  return server;
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const server = await buildServer();

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, "shutting down");
    try {
      await server.close();
      await closeMongo();
      process.exit(0);
    } catch (err) {
      server.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.listen({ host: config.HOST, port: config.MEMORY_PORT });
}

// Autostart only when this file is the process entry point; imports under
// vitest or as a module must not bind a port.
const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("memory service failed to start:", err);
    process.exit(1);
  });
}
