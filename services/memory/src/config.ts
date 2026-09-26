import { z } from "zod";
import { loadEnv } from "@hearthkeeper/libs";

const configSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  MEMORY_PORT: z.coerce.number().default(3002),
  MONGO_URI: z.string().default("mongodb://127.0.0.1:27017"),
  MONGO_DB: z.string().default("hearthkeeper"),
  // Deliberately not z.coerce.boolean(): that maps the string "false" to
  // true. Parse the raw string and interpret only "true"/true as enabled.
  MONGO_ENSURE_INDEXES: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((value) => value === true || value === "true"),
});

export type MemoryConfig = z.infer<typeof configSchema>;

export function loadConfig(
  source: Record<string, string | undefined> = process.env,
): MemoryConfig {
  return loadEnv(configSchema, source);
}
