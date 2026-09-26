/**
 * Voice liaison inside services/gm. Kept as a thin module
 * here for the scaffold; it may split into its own service later if the
 * voice path grows, so its contract is already isolated behind a client.
 *
 * Chatterbox is consumed as a separate service. Its /api/model-info endpoint
 * is used as a health probe.
 */
import { pcmDurationMs } from "../narration/wav.js";
import { abortableDelay, throwIfAborted, withAbortTimeout } from "../abort.js";

export interface ChatterboxConfig {
  baseUrl: string;
  voiceMode: string;
  referenceAudioFilename: string;
}

export interface SynthesizeOptions {
  seed?: number;
  temperature?: number;
  speed?: number;
  signal?: AbortSignal;
}
export interface StreamSynthesizeOptions extends SynthesizeOptions {
  /** Server chunk size for streamed synthesis (see config GM_TTS_CHUNK_SIZE). */
  chunkSize?: number;
}

export interface StreamedSynthesis {
  buffer: Uint8Array;
  durationMs: number | null;
}

/** Random 31-bit int — a non-magic default seed per synthesis (variety). */
function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** Concatenate streamed chunks into one buffer. */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export class ChatterboxColdStartError extends Error {
  readonly retryable = true;
}

export class ChatterboxRequestError extends Error {}

export class ChatterboxClient {
  constructor(
    private cfg: ChatterboxConfig,
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = 90_000,
  ) {}

  /**
   * Whole-utterance synthesis:
   * one POST per narration beat, binary audio back. Turbo ignores the
   * exaggeration field; it is kept for contract completeness. Seed defaults
   * to a fresh random 31-bit int per
   * call — variety across beats; determinism is not required.
   */
  async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<ArrayBuffer> {
    const timeout = withAbortTimeout(opts.signal, this.timeoutMs, "chatterbox synthesis");
    try {
      const response = await this.fetchImpl(`${this.cfg.baseUrl}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice_mode: this.cfg.voiceMode,
          reference_audio_filename: this.cfg.referenceAudioFilename,
          temperature: opts.temperature ?? 0.8,
          exaggeration: 0.5,
          speed: opts.speed ?? 1.0,
          seed: opts.seed ?? randomSeed(),
        }),
        signal: timeout.signal,
      });
      if (response.status === 503) {
        throw new ChatterboxColdStartError("chatterbox model is cold-starting; retry shortly");
      }
      if (!response.ok) {
        throw new ChatterboxRequestError(`chatterbox /tts failed: HTTP ${response.status}`);
      }
      return await response.arrayBuffer();
    } finally {
      timeout.dispose();
    }
  }

  /**
   * synthesize with cold-start retry: ONLY ChatterboxColdStartError (503)
   * is retried, with exponential backoff (≈35s total — covers the ~12s
   * model load plus the 15–30s first-synthesis cold start). Any other
   * failure surfaces immediately as ChatterboxRequestError; exhausting the
   * attempts surfaces ChatterboxColdStartError. delayFn is injectable for
   * tests.
   */
  async synthesizeWithRetry(
    text: string,
    opts: SynthesizeOptions = {},
    deps: {
      delayFn?: (ms: number) => Promise<void>;
      maxAttempts?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ArrayBuffer> {
    const signal = deps.signal ?? opts.signal;
    return this.withColdStartRetry(() => this.synthesize(text, { ...opts, signal }), { ...deps, signal });
  }

  /**
   * Streaming synthesis (post-MVP adoption): POST /tts with stream:true —
   * the server answers with a WAV StreamingResponse (header after the
   * first chunk synthesizes, then per-chunk PCM16). Concatenating the
   * body yields one playable WAV. Duration is derived from ACTUAL PCM
   * bytes (pcmDurationMs) because streamed WAV headers carry a PLACEHOLDER
   * data-size — the header must never be trusted for pacing. Body carries
   * the whole-utterance fields plus stream:true and chunk_size (default 100).
   */
  async synthesizeStream(
    text: string,
    opts: StreamSynthesizeOptions = {},
  ): Promise<StreamedSynthesis> {
    const timeout = withAbortTimeout(opts.signal, this.timeoutMs, "chatterbox stream");
    try {
      const response = await this.fetchImpl(`${this.cfg.baseUrl}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice_mode: this.cfg.voiceMode,
          reference_audio_filename: this.cfg.referenceAudioFilename,
          temperature: opts.temperature ?? 0.8,
          exaggeration: 0.5,
          speed: opts.speed ?? 1.0,
          seed: opts.seed ?? randomSeed(),
          stream: true,
          chunk_size: opts.chunkSize ?? 100,
        }),
        signal: timeout.signal,
      });
      if (response.status === 503) {
        throw new ChatterboxColdStartError("chatterbox model is cold-starting; retry shortly");
      }
      if (!response.ok) {
        throw new ChatterboxRequestError(`chatterbox /tts failed: HTTP ${response.status}`);
      }
      if (!response.body) {
        throw new ChatterboxRequestError("chatterbox /tts stream returned no body");
      }
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      const buffer = concatChunks(chunks);
      return { buffer, durationMs: pcmDurationMs(buffer) };
    } finally {
      timeout.dispose();
    }
  }

  /**
   * Streaming synthesis with the same 503-only cold-start retry contract as
   * synthesizeWithRetry (same backoff schedule, injectable delayFn/maxAttempts).
   */
  async synthesizeStreamWithRetry(
    text: string,
    opts: StreamSynthesizeOptions = {},
    deps: {
      delayFn?: (ms: number) => Promise<void>;
      maxAttempts?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<StreamedSynthesis> {
    const signal = deps.signal ?? opts.signal;
    return this.withColdStartRetry(() => this.synthesizeStream(text, { ...opts, signal }), { ...deps, signal });
  }

  private async withColdStartRetry<T>(
    attempt: () => Promise<T>,
    deps: {
      delayFn?: (ms: number) => Promise<void>;
      maxAttempts?: number;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const delayFn = deps.delayFn ?? ((ms: number) => abortableDelay(ms, deps.signal));
    const maxAttempts = deps.maxAttempts ?? 6;
    const backoff = [1000, 2000, 4000, 8000, 10000, 10000];

    for (let n = 1; n <= maxAttempts; n++) {
      throwIfAborted(deps.signal);
      try {
        return await attempt();
      } catch (err) {
        const coldStart = err instanceof ChatterboxColdStartError;
        if (!coldStart || n === maxAttempts) throw err;
        await delayFn(backoff[Math.min(n - 1, backoff.length - 1)]);
      }
    }
    // Unreachable: the loop either returns or throws on its last attempt.
    throw new ChatterboxColdStartError("chatterbox cold start: retry attempts exhausted");
  }

  /** Health probe for the TTS service. */
  async modelInfo(): Promise<unknown> {
    const timeout = withAbortTimeout(undefined, Math.min(this.timeoutMs, 2_000), "chatterbox health probe");
    try {
      const response = await this.fetchImpl(`${this.cfg.baseUrl}/api/model-info`, {
        method: "GET",
        signal: timeout.signal,
      });
      if (!response.ok) {
        throw new ChatterboxRequestError(
          `chatterbox /api/model-info failed: HTTP ${response.status}`,
        );
      }
      return response.json();
    } finally {
      timeout.dispose();
    }
  }
}
