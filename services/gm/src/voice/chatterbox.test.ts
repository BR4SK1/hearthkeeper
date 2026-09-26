import { describe, expect, it } from "vitest";
import {
  ChatterboxClient,
  ChatterboxColdStartError,
  ChatterboxRequestError,
} from "./chatterbox.js";

const cfg = {
  baseUrl: "http://localhost:8000",
  voiceMode: "clone",
  referenceAudioFilename: "reference.wav",
};

function fetchResponding(status: number, body: string = "ok"): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      init,
    });
    return new Response(body, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("ChatterboxClient.synthesize", () => {
  it("POSTs the settled contract body to {baseUrl}/tts", async () => {
    const { fetchImpl, calls } = fetchResponding(200, "PCM-BYTES");
    const client = new ChatterboxClient(cfg, fetchImpl);
    await client.synthesize("The market hums.", { seed: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:8000/tts");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      text: "The market hums.",
      voice_mode: "clone",
      reference_audio_filename: "reference.wav",
      temperature: 0.8,
      exaggeration: 0.5,
      speed: 1.0,
      seed: 42,
    });
  });

  it("maps HTTP 503 to ChatterboxColdStartError", async () => {
    const { fetchImpl } = fetchResponding(503);
    const client = new ChatterboxClient(cfg, fetchImpl);
    await expect(client.synthesize("hello")).rejects.toThrowError(
      ChatterboxColdStartError,
    );
  });

  it("maps other non-2xx to ChatterboxRequestError", async () => {
    const { fetchImpl } = fetchResponding(500);
    const client = new ChatterboxClient(cfg, fetchImpl);
    await expect(client.synthesize("hello")).rejects.toThrowError(
      ChatterboxRequestError,
    );
  });

  it("returns the response body as an ArrayBuffer on success", async () => {
    const { fetchImpl } = fetchResponding(200, "PCM-BYTES");
    const client = new ChatterboxClient(cfg, fetchImpl);
    const audio = await client.synthesize("hello");
    expect(audio).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(audio)).toBe("PCM-BYTES");
  });

  it("aborts a stalled synthesis request at its configured deadline", async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const client = new ChatterboxClient(cfg, fetchImpl, 5);
    await expect(client.synthesize("stalled")).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("ChatterboxClient.modelInfo", () => {
  it("GETs {baseUrl}/api/model-info — the health probe", async () => {
    const { fetchImpl, calls } = fetchResponding(200, '{"model":"turbo"}');
    const client = new ChatterboxClient(cfg, fetchImpl);
    await expect(client.modelInfo()).resolves.toEqual({ model: "turbo" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:8000/api/model-info");
    expect(calls[0].init?.method).toBe("GET");
  });
});

describe("ChatterboxClient.synthesize body contract", () => {
  it("sends voice_mode, reference filename, and a numeric seed; honors seed override", async () => {
    const { fetchImpl, calls } = fetchResponding(200, "PCM");
    const client = new ChatterboxClient(cfg, fetchImpl);
    await client.synthesize("hello", { seed: 12345, temperature: 0.5, speed: 0.9 });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.voice_mode).toBe("clone");
    expect(body.reference_audio_filename).toBe("reference.wav");
    expect(body.seed).toBe(12345);
    expect(body.temperature).toBe(0.5);
    expect(body.speed).toBe(0.9);
    expect(typeof body.exaggeration).toBe("number"); // contract completeness

    await client.synthesize("again"); // no override: seed is a fresh random int
    const body2 = JSON.parse(calls[1].init?.body as string);
    expect(Number.isInteger(body2.seed)).toBe(true);
    expect(body2.seed).toBeGreaterThan(0);
  });
});

describe("ChatterboxClient.synthesizeWithRetry", () => {
  function fetchStatuses(statuses: number[]): {
    fetchImpl: typeof fetch;
    statusCalls: number[];
  } {
    const statusCalls: number[] = [];
    const fetchImpl = (async (_input: string | URL | Request) => {
      const status = statuses[Math.min(statusCalls.length, statuses.length - 1)];
      statusCalls.push(status);
      return new Response(status === 200 ? "AUDIO" : "cold", { status });
    }) as typeof fetch;
    return { fetchImpl, statusCalls };
  }

  const noDelay = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };
  let delays: number[];

  it("retries 503s with backoff and succeeds", async () => {
    delays = [];
    const { fetchImpl, statusCalls } = fetchStatuses([503, 503, 200]);
    const client = new ChatterboxClient(cfg, fetchImpl);
    const audio = await client.synthesizeWithRetry("hello", {}, { delayFn: noDelay });
    expect(new TextDecoder().decode(audio)).toBe("AUDIO");
    expect(statusCalls).toEqual([503, 503, 200]);
    expect(delays).toEqual([1000, 2000]);
  });

  it("exhausting all attempts on 503 throws ChatterboxColdStartError", async () => {
    delays = [];
    const { fetchImpl, statusCalls } = fetchStatuses([503]);
    const client = new ChatterboxClient(cfg, fetchImpl);
    await expect(
      client.synthesizeWithRetry("hello", {}, { delayFn: noDelay, maxAttempts: 6 }),
    ).rejects.toThrowError(ChatterboxColdStartError);
    expect(statusCalls).toHaveLength(6);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 10000]);
  });

  it("does not retry non-503 failures: exactly one fetch", async () => {
    delays = [];
    const { fetchImpl, statusCalls } = fetchStatuses([500]);
    const client = new ChatterboxClient(cfg, fetchImpl);
    await expect(
      client.synthesizeWithRetry("hello", {}, { delayFn: noDelay }),
    ).rejects.toThrowError(ChatterboxRequestError);
    expect(statusCalls).toEqual([500]);
    expect(delays).toEqual([]);
  });
});

describe("ChatterboxClient.synthesizeStream", () => {
  /** Wav bytes built like wav.test's helper (24kHz mono 16-bit). */
  function makeWav(sampleCount: number, headerDataSize?: number): Uint8Array {
    const dataBytes = sampleCount * 2;
    const buffer = new Uint8Array(44 + dataBytes);
    const view = new DataView(buffer.buffer);
    const ascii = (offset: number, text: string): void => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 24000, true);
    view.setUint32(28, 48000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, headerDataSize ?? dataBytes, true);
    return buffer;
  }

  /** Streamed response body emitting the wav in arbitrary chunks (split mid-header). */
  function streamedResponse(wav: Uint8Array, cuts: number[]): Response {
    const chunks = cuts.map((_, i) => wav.subarray(cuts[i - 1] ?? 0, cuts[i])).concat(wav.subarray(cuts[cuts.length - 1] ?? 0));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk.slice());
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  it("POSTs the stream contract body (stream:true, chunk_size default and override)", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: typeof _input === "string" ? _input : _input.toString(), init });
      return streamedResponse(makeWav(2400), [100]);
    }) as typeof fetch;
    const client = new ChatterboxClient(cfg, fetchImpl);

    await client.synthesizeStream("hello");
    expect(JSON.parse(calls[0].init?.body as string)).toMatchObject({
      text: "hello",
      voice_mode: "clone",
      reference_audio_filename: "reference.wav",
      stream: true,
      chunk_size: 100,
    });

    await client.synthesizeStream("again", { chunkSize: 200, seed: 7 });
    expect(JSON.parse(calls[1].init?.body as string)).toMatchObject({
      chunk_size: 200,
      seed: 7,
      stream: true,
    });
  });

  it("assembles a chunked streamed body byte-equal and derives duration from PCM despite a placeholder header", async () => {
    // 1s of audio; the header lies (placeholder data-size = 8).
    const wav = makeWav(24000, 8);
    const fetchImpl = (async (): Promise<Response> => streamedResponse(wav, [3, 25, 50, 900])) as typeof fetch;
    const client = new ChatterboxClient(cfg, fetchImpl);

    const { buffer, durationMs } = await client.synthesizeStream("hello");
    expect(buffer).toBeInstanceOf(Uint8Array);
    expect(buffer.length).toBe(wav.length);
    expect(Array.from(buffer)).toEqual(Array.from(wav)); // byte-equal assembly
    expect(durationMs).toBeCloseTo(1000, 0); // PCM-derived, header ignored
  });

  it("retries 503s on the streamed path only, immediate on non-503", async () => {
    const delays: number[] = [];
    const noDelay = (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    };
    let statusCalls = 0;
    let lastStatus = 0;
    const fetchByStatus = (status: number): typeof fetch => {
      lastStatus = status;
      return (async (): Promise<Response> => {
        statusCalls++;
        return new Response("cold", { status });
      }) as typeof fetch;
    };

    // 503 → 503 → 200: delays [1000, 2000]
    statusCalls = 0;
    let current: typeof fetch = (async () => {
      statusCalls++;
      if (statusCalls < 3) return new Response("cold", { status: 503 });
      return streamedResponse(makeWav(2400), [10]);
    }) as typeof fetch;
    lastStatus = 200;
    void lastStatus;
    const clientRetry = new ChatterboxClient(cfg, current);
    const ok = await clientRetry.synthesizeStreamWithRetry("hello", {}, { delayFn: noDelay });
    expect(ok.buffer.length).toBeGreaterThan(0);
    expect(delays).toEqual([1000, 2000]);

    // 500: exactly one attempt, ChatterboxRequestError
    statusCalls = 0;
    const clientFail = new ChatterboxClient(cfg, fetchByStatus(500));
    await expect(
      clientFail.synthesizeStreamWithRetry("hello", {}, { delayFn: noDelay }),
    ).rejects.toThrowError(ChatterboxRequestError);
    expect(statusCalls).toBe(1);
  });
});
