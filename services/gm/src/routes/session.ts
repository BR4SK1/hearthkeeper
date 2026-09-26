/**
 * Session routes: GET /v1/session/status (state + busy gate) and
 * POST /v1/session/reset (clears conversation history; the machine is left
 * untouched — reset is a memory wipe, not a state change).
 */
import type { FastifyInstance } from "fastify";
import type { ChatMessage } from "../llm/openrouter.js";
import type { SessionStateMachine } from "../session/machine.js";

export interface SessionRouteDeps {
  machine: SessionStateMachine;
  history: ChatMessage[];
  busyFlag: { inFlight: boolean };
}

export function registerSessionRoutes(server: FastifyInstance, deps: SessionRouteDeps): void {
  server.get("/v1/session/status", async (_request, reply) => {
    reply.code(200).send({
      state: deps.machine.state,
      busy: deps.busyFlag.inFlight,
      turns: Math.floor(deps.history.length / 2),
    });
  });

  server.post("/v1/session/reset", async (_request, reply) => {
    if (deps.busyFlag.inFlight) {
      return reply.code(409).send({ error: "cannot reset while gm is narrating" });
    }
    deps.history.length = 0;
    reply.code(200).send({ ok: true });
  });
}
