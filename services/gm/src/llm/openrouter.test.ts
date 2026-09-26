import { describe, expect, it } from "vitest";
import {
  MissingApiKeyError,
  OpenRouterClient,
  OpenRouterResponseError,
} from "./openrouter.js";
import { buildPresets } from "./presets.js";
import { DEFAULT_GM_PORT } from "../config.js";

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function capturingFetch(
  status = 200,
  body: string | (() => Response) = JSON.stringify({ choices: [{ message: { content: "hello" } }] }),
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      init,
    });
    if (typeof body === "function") return body();
    return new Response(body, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Build an SSE Response whose body streams the given chunks (may split mid-line). */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function sseBody(deltas: string[], splitMidLine = true): () => Response {
  const events = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`);
  events.push("data: [DONE]\n\n");
  const whole = events.join("");
  if (!splitMidLine) return () => sseResponse([whole]);
  // Split at an awkward point: mid-way through the second event's JSON.
  const cut = Math.floor(whole.length / 3);
  return () => sseResponse([whole.slice(0, cut), whole.slice(cut)]);
}

describe("OpenRouterClient.chat", () => {
  it("throws MissingApiKeyError before any fetch when the key is missing", async () => {
    const { fetchImpl, calls } = capturingFetch();
    const client = new OpenRouterClient({ fetchImpl });
    await expect(client.chat("narration", [{ role: "user", content: "hi" }], "m")).rejects.toThrowError(
      MissingApiKeyError,
    );
    expect(calls).toHaveLength(0);
  });

  it("throws MissingApiKeyError for an empty key", async () => {
    const { fetchImpl, calls } = capturingFetch();
    const client = new OpenRouterClient({ apiKey: "   ", fetchImpl });
    await expect(client.chat("narration", [], "m")).rejects.toThrowError(
      MissingApiKeyError,
    );
    expect(calls).toHaveLength(0);
  });

  it("POSTs to the chat/completions endpoint with Bearer auth and the classification preset", async () => {
    const { fetchImpl, calls } = capturingFetch();
    const client = new OpenRouterClient({ apiKey: "test-key", fetchImpl });
    const result = await client.chat("classification", [{ role: "user", content: "route me" }], "model-x");

    expect(result).toBe("hello");
    const classification = buildPresets("model-x").classification;
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["X-Title"]).toBe("hearthkeeper-gm");
    expect(headers["HTTP-Referer"]).toBe(`http://localhost:${DEFAULT_GM_PORT}`);
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({
      model: "model-x",
      temperature: classification.temperature,
      max_tokens: classification.maxTokens,
      reasoning: { enabled: false },
      messages: [{ role: "user", content: "route me" }],
    });
  });

  it("throws OpenRouterResponseError on a non-2xx", async () => {
    const { fetchImpl } = capturingFetch(502, "bad gateway");
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    await expect(client.chat("narration", [], "m")).rejects.toThrowError(
      OpenRouterResponseError,
    );
  });

  it("throws OpenRouterResponseError on a malformed body", async () => {
    const { fetchImpl } = capturingFetch(200, '{"choices":[]}');
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    await expect(client.chat("narration", [], "m")).rejects.toThrowError(
      OpenRouterResponseError,
    );
  });
});

describe("OpenRouterClient.chatStream", () => {
  it("accumulates streamed deltas, fires onDelta, and parses SSE split mid-line", async () => {
    const deltas = ["The rain ", "hammers the awning. ", "[sigh] The city never sleeps."];
    const { fetchImpl, calls } = capturingFetch(200, sseBody(deltas));
    const client = new OpenRouterClient({ apiKey: "test-key", fetchImpl });

    const seen: string[] = [];
    const full = await client.chatStream(
      "narration",
      [{ role: "user", content: "go" }],
      "model-x",
      (delta) => seen.push(delta),
    );

    expect(full).toBe(deltas.join(""));
    expect(seen).toEqual(deltas);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    const body = JSON.parse(calls[0].init?.body as string);
    const preset = buildPresets("model-x").narration;
    expect(body.stream).toBe(true);
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.temperature).toBe(preset.temperature);
    expect(body.max_tokens).toBe(preset.maxTokens);
    expect(body.model).toBe("model-x");
  });

  it("throws MissingApiKeyError before any fetch", async () => {
    const { fetchImpl, calls } = capturingFetch(200, sseBody(["x"]));
    const client = new OpenRouterClient({ fetchImpl });
    await expect(
      client.chatStream("narration", [], "m"),
    ).rejects.toThrowError(MissingApiKeyError);
    expect(calls).toHaveLength(0);
  });

  it("maps a non-2xx to OpenRouterResponseError with the body detail", async () => {
    const { fetchImpl } = capturingFetch(401, "bad key");
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    await expect(client.chatStream("narration", [], "m")).rejects.toThrowError(
      OpenRouterResponseError,
    );
  });

  it("rejects a truncated SSE stream that never sends [DONE]", async () => {
    const { fetchImpl } = capturingFetch(200, () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
    ]));
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    await expect(client.chatStream("narration", [], "m")).rejects.toThrowError(/before its \[DONE\] marker/);
  });

  it("rejects malformed SSE data instead of committing partial narration", async () => {
    const { fetchImpl } = capturingFetch(200, () => sseResponse(["data: {not-json}\n\ndata: [DONE]\n\n"]));
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    await expect(client.chatStream("narration", [], "m")).rejects.toThrowError(/malformed event data/);
  });

  it("aborts a stalled upstream stream at its configured deadline", async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl, timeoutMs: 5 });
    await expect(client.chatStream("narration", [], "m")).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("OpenRouterClient max_tokens override", () => {
  it("honors the override in the non-stream body", async () => {
    const { fetchImpl, calls } = capturingFetch(200);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    await client.chat("narration", [{ role: "user", content: "go" }], "m", { maxTokens: 123 });
    expect(JSON.parse(calls[0].init?.body as string).max_tokens).toBe(123);
  });

  it("honors the override in the stream body", async () => {
    const { fetchImpl, calls } = capturingFetch(200, sseBody(["x"]));
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    await client.chatStream("narration", [], "m", undefined, { maxTokens: 456 });
    expect(JSON.parse(calls[0].init?.body as string).max_tokens).toBe(456);
  });

  it("keeps preset max_tokens when no override is given", async () => {
    const { fetchImpl, calls } = capturingFetch(200);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    await client.chat("narration", [{ role: "user", content: "go" }], "m");
    expect(JSON.parse(calls[0].init?.body as string).max_tokens).toBe(700);
  });
});
