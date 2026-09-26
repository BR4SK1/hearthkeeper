/**
 * POST /v1/turn — the streaming narration route (wire contract): NDJSON,
 * one JSON object per line — ack, then one beat event per synthesized beat
 * in order, then done; fatal failures emit error and close. One in-flight
 * turn at a time; a second concurrent request gets 409.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TurnDeps } from "../narration/pipeline.js";
import { runTurn } from "../narration/pipeline.js";

const turnBody = z.object({ text: z.string().min(1) });

export interface TurnRouteDeps extends TurnDeps {
  /** Shared with /v1/session/status so clients can gate on busy. */
  busyFlag: { inFlight: boolean };
}

export function registerTurnRoute(server: FastifyInstance, deps: TurnRouteDeps): void {
  server.post("/v1/turn", async (request, reply) => {
    const parsed = turnBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "body must be {\"text\": string} with non-empty text" });
    }
    if (deps.busyFlag.inFlight) {
      return reply.code(409).send({ error: "gm is already narrating" });
    }

    deps.busyFlag.inFlight = true;
    const text = parsed.data.text;

    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      "Transfer-Encoding": "chunked",
    });

    const controller = new AbortController();
    const onRequestAborted = (): void => controller.abort(new DOMException("client disconnected", "AbortError"));
    const onResponseClosed = (): void => {
      if (!reply.raw.writableEnded) onRequestAborted();
    };
    request.raw.once("aborted", onRequestAborted);
    reply.raw.once("close", onResponseClosed);

    const send = (event: unknown): void => {
      if (controller.signal.aborted || reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`${JSON.stringify(event)}\n`);
      // Flush as soon as the event is written — beats must stream as each
      // synthesis completes, never buffer (no-buffering contract).
      const flushable = reply.raw as { flush?: () => void };
      flushable.flush?.();
    };

    const withLog: TurnRouteDeps = { ...deps, log: (line: string) => request.log.warn(line) };

    try {
      await runTurn(withLog, text, send, controller.signal);
    } finally {
      deps.busyFlag.inFlight = false;
      request.raw.off("aborted", onRequestAborted);
      reply.raw.off("close", onResponseClosed);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
    return reply;
  });
}
