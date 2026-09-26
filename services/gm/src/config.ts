import { z } from "zod";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv } from "@hearthkeeper/libs";
import { DEFAULT_PREMISE } from "./llm/prompts.js";

/** Default listen port for the gm service (see the comment in configSchema). */
export const DEFAULT_GM_PORT = 3001;

/**
 * Default directory for the pre-rendered filler wavs: <package
 * root>/assets/fillers, resolved from this file's location so it works
 * under tsx (src/) and compiled (dist/) alike — both are one level below
 * the package root.
 */
export const DEFAULT_FILLER_ASSETS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "fillers",
);

const configSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  GM_PORT: z.coerce.number().default(DEFAULT_GM_PORT),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("openai/gpt-4o-mini"),
  GM_MAX_TOKENS: z.coerce.number().int().positive().default(700),
  GM_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  GM_TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  GM_TURN_LENGTH: z.enum(["short", "adaptive", "long"]).default("adaptive"),
  GM_TTS_STREAM: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((value) => value === true || value === "true"),
  GM_TTS_CHUNK_SIZE: z.coerce.number().int().positive().default(100),
  GM_PREMISE: z.string().default(DEFAULT_PREMISE),
  FILLER_ASSETS_DIR: z.string().default(DEFAULT_FILLER_ASSETS_DIR),
  CHATTERBOX_BASE_URL: z.string().default("http://localhost:8000"),
  CHATTERBOX_VOICE_MODE: z.string().default("clone"),
  CHATTERBOX_REFERENCE_AUDIO: z.string().default("reference.wav"),
});

export type GmConfig = z.infer<typeof configSchema>;

export function loadConfig(
  source: Record<string, string | undefined> = process.env,
): GmConfig {
  return loadEnv(configSchema, source);
}
