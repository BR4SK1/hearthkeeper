import { z } from "zod";

/**
 * Typed environment loader. Parses a source (process.env by default) against a
 * zod schema; numeric and boolean fields are coerced by the schema itself.
 * On failure, throws an Error listing every missing or invalid key so the
 * offending service fails loudly at boot instead of drifting at runtime.
 */
export function loadEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (result.success) {
    return result.data;
  }
  const problems = result.error.issues.map((issue) => {
    const key = issue.path.join(".") || "(root)";
    return `  - ${key}: ${issue.message}`;
  });
  throw new Error(
    `environment validation failed (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n${problems.join("\n")}`,
  );
}
