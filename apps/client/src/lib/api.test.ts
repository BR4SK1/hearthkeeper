import { afterEach, describe, expect, it, vi } from "vitest";
import { postTurn, type TurnEvent } from "./api.js";

/** NDJSON response body streamed as string chunks (may cut mid-line). */
function ndjsonResponse(lines: string[], cuts: number[], status = 200): Response {
  const whole = lines.map((l) => `${l}\n`).join("");
  const chunks = cuts.length === 0 ? [whole] : cuts.map((_, i) => whole.slice(cuts[i - 1] ?? 0, cuts[i])).concat(whole.slice(cuts[cuts.length - 1] ?? 0));
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postTurn", () => {
  it("dispatches streamed events in order, even when chunks cut lines", async () => {
    const events = [
      '{"type":"ack","filler":{"id":"ack-hmm","text":"Hmm...","audioHref":"/v1/audio/fill-ack-hmm.wav"}}',
      '{"type":"beat","i":0,"turnId":"t1","text":"One.","audioHref":"/v1/audio/t1-0.wav","degraded":false,"synthMs":100,"durationMs":900}',
      '{"type":"beat","i":1,"turnId":"t1","text":"Two.","audioHref":null,"degraded":true,"synthMs":100,"durationMs":null}',
      '{"type":"done","turnId":"t1","firstBeatMs":5120,"totalMs":13100,"beats":2}',
    ];
    // Cut the payload at awkward offsets (mid-line, mid-JSON).
    const payload = events.map((e) => `${e}\n`).join("");
    const cuts = [3, 20, 55, 90, 130];
    const fetchImpl = async (): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            let cursor = 0;
            for (const cut of [...cuts, payload.length]) {
              controller.enqueue(encoder.encode(payload.slice(cursor, cut)));
              cursor = cut;
            }
            controller.close();
          },
        }),
        { status: 200 },
      );
    vi.stubGlobal("fetch", fetchImpl);

    const received: unknown[] = [];
    await postTurn("intent", (event) => received.push(event));

    expect(received).toHaveLength(4);
    expect((received[0] as { type: string }).type).toBe("ack");
    expect((received[1] as { type: string }).type).toBe("beat");
    expect((received[2] as { degraded: boolean }).degraded).toBe(true);
    expect((received[3] as { type: string }).type).toBe("done");
  });

  it("throws the friendly busy message on 409", async () => {
    vi.stubGlobal("fetch", async (): Promise<Response> => new Response("busy", { status: 409 }));
    await expect(postTurn("intent", () => undefined)).rejects.toThrowError(/already narrating/);
  });

  it("surfaces non-2xx with status and body detail", async () => {
    vi.stubGlobal("fetch", async (): Promise<Response> => new Response("boom", { status: 500 }));
    await expect(postTurn("intent", () => undefined)).rejects.toThrowError(/HTTP 500 — boom/);
  });

  it("flushes a trailing partial line at end of stream", async () => {
    const fetchImpl = async (): Promise<Response> => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"type":"done","turnId":"t9","firstBeatMs":null'));
            controller.enqueue(encoder.encode(',"totalMs":10,"beats":0}')); // no trailing newline
            controller.close();
          },
        }),
        { status: 200 },
      );
    };
    vi.stubGlobal("fetch", fetchImpl);

    const received: unknown[] = [];
    await postTurn("intent", (event) => received.push(event));
    expect(received).toEqual([
      { type: "done", turnId: "t9", firstBeatMs: null, totalMs: 10, beats: 0 },
    ]);
  });

  it("dispatches an event while the response body remains open", async () => {
    let release!: () => void;
    const waitToClose = new Promise<void>((resolve) => { release = resolve; });
    let closed = false;
    const line = '{"type":"beat","i":0,"turnId":"t1","text":"Early.","audioHref":null,"degraded":true,"synthMs":1,"durationMs":null}\n';
    vi.stubGlobal("fetch", async (): Promise<Response> => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(line));
          void waitToClose.then(() => {
            closed = true;
            controller.close();
          });
        },
      });
      return new Response(stream, { status: 200 });
    });

    const received: TurnEvent[] = [];
    const pending = postTurn("intent", (event) => received.push(event));
    for (let attempt = 0; attempt < 20 && received.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(received.map((event) => event.type)).toEqual(["beat"]);
    expect(closed).toBe(false);
    release();
    await pending;
  });
});
