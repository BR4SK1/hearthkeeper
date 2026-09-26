import type { TaskName } from "./presets.js";
import { buildPresets } from "./presets.js";
import { DEFAULT_GM_PORT } from "../config.js";
import { withAbortTimeout } from "../abort.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class MissingApiKeyError extends Error {}

export class OpenRouterResponseError extends Error {}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface ChatCompletionRequest {
  model: string;
  temperature: number;
  max_tokens: number;
  stream?: boolean;
  reasoning?: { enabled: boolean };
  messages: ChatMessage[];
}

/**
 * Per-call overrides on top of the task preset.
 */
export interface ChatOverrides {
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * Stub OpenRouter chat client. No live calls in tests: the fetch
 * implementation is injected, so unit tests capture the request instead of
 * hitting the network. Chat behavior itself is wired in Phase 4.
 */
export class OpenRouterClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly referer: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: {
    apiKey?: string;
    baseUrl?: string;
    /** Public URL reported to OpenRouter; defaults to the configured gm port. */
    referer?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";
    this.referer = opts.referer ?? `http://localhost:${DEFAULT_GM_PORT}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
  }

  private headers(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.apiKey}`,
      "HTTP-Referer": this.referer,
      "X-Title": "hearthkeeper-gm",
      "Content-Type": "application/json",
    };
  }

  async chat(
    task: TaskName,
    messages: ChatMessage[],
    model: string,
    overrides: ChatOverrides = {},
  ): Promise<string> {
    if (!this.apiKey || this.apiKey.trim() === "") {
      throw new MissingApiKeyError(
        "OPENROUTER_API_KEY is missing or empty; cannot call OpenRouter",
      );
    }

    const preset = buildPresets(model)[task];
    const body: ChatCompletionRequest = {
      model,
      temperature: preset.temperature,
      max_tokens: overrides.maxTokens ?? preset.maxTokens,
      // Narration needs spoken prose immediately; GLM 5.3 (the
      // ~z-ai/glm-latest alias) is a reasoning model — without disabling
      // reasoning, delta.content stays empty while reasoning tokens burn
      // the output budget.
      reasoning: { enabled: false },
      messages,
    };

    const timeout = withAbortTimeout(overrides.signal, this.timeoutMs, "openrouter chat");
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: timeout.signal,
      });
      if (!response.ok) {
        throw new OpenRouterResponseError(
          `openrouter chat failed: HTTP ${response.status}`,
        );
      }

      let parsed: ChatCompletionResponse;
      try {
        parsed = (await response.json()) as ChatCompletionResponse;
      } catch (err) {
        throw new OpenRouterResponseError("openrouter returned a malformed body", {
          cause: err,
        });
      }
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new OpenRouterResponseError(
          "openrouter response is missing choices[0].message.content",
        );
      }
      return content;
    } finally {
      timeout.dispose();
    }
  }

  /**
   * Streaming chat: POSTs with stream:true and parses the SSE response body
   * incrementally — lines starting "data: " carry JSON chunks whose
   * choices[0].delta.content is the next text fragment; "data: [DONE]"
   * ends the stream. Partial lines across chunk boundaries are buffered.
   * onDelta fires per content delta as it arrives; the full text resolves
   * when the stream completes. MissingApiKeyError is thrown before any
   * fetch; non-2xx responses surface as OpenRouterResponseError with the
   * response body.
   */
  async chatStream(
    task: TaskName,
    messages: ChatMessage[],
    model: string,
    onDelta?: (delta: string) => void,
    overrides: ChatOverrides = {},
  ): Promise<string> {
    if (!this.apiKey || this.apiKey.trim() === "") {
      throw new MissingApiKeyError(
        "OPENROUTER_API_KEY is missing or empty; cannot call OpenRouter",
      );
    }

    const preset = buildPresets(model)[task];
    const body: ChatCompletionRequest = {
      model,
      temperature: preset.temperature,
      max_tokens: overrides.maxTokens ?? preset.maxTokens,
      stream: true,
      // Narration needs spoken prose immediately; GLM 5.3 (the
      // ~z-ai/glm-latest alias) is a reasoning model — without disabling
      // reasoning, delta.content stays empty while reasoning tokens burn
      // the output budget.
      reasoning: { enabled: false },
      messages,
    };

    const timeout = withAbortTimeout(overrides.signal, this.timeoutMs, "openrouter stream");
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: timeout.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new OpenRouterResponseError(
          `openrouter chat stream failed: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
        );
      }
      if (!response.body) {
        throw new OpenRouterResponseError("openrouter stream returned no body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";
      let sawDone = false;

      const handleDataLine = (line: string): void => {
        const payload = line.slice("data: ".length);
        if (payload === "[DONE]") {
          sawDone = true;
          return;
        }
        let chunk: {
          error?: { message?: string };
          choices?: Array<{ delta?: { content?: string } }>;
        };
        try {
          chunk = JSON.parse(payload) as typeof chunk;
        } catch (err) {
          throw new OpenRouterResponseError("openrouter stream contained malformed event data", { cause: err });
        }
        if (chunk.error) {
          throw new OpenRouterResponseError(`openrouter stream error: ${chunk.error.message ?? "unknown error"}`);
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          full += delta;
          onDelta?.(delta);
        }
      };

      reader = response.body.getReader();
      while (!sawDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1 && !sawDone) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
          buffer = buffer.slice(newlineIndex + 1);
          if (line.startsWith("data: ")) handleDataLine(line);
          newlineIndex = buffer.indexOf("\n");
        }
      }
      if (!sawDone) {
        buffer += decoder.decode();
        // Tolerate a final data line without the SSE trailing newline.
        const remainder = buffer.replace(/\r$/, "");
        if (remainder.startsWith("data: ")) handleDataLine(remainder);
      }
      if (!sawDone) {
        throw new OpenRouterResponseError("openrouter stream ended before its [DONE] marker");
      }
      return full;
    } finally {
      if (reader !== null) {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      timeout.dispose();
    }
  }
}
