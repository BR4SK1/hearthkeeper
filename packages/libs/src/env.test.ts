import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  const schema = z.object({
    PORT: z.coerce.number(),
    LOG_LEVEL: z.string().default("info"),
    REQUIRED_TOKEN: z.string(),
  });

  it("parses a coerced number, an optional-with-default, and a required string", () => {
    const env = loadEnv(schema, {
      PORT: "4310",
      REQUIRED_TOKEN: "secret",
    });
    expect(env.PORT).toBe(4310);
    expect(env.PORT).toBeTypeOf("number");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.REQUIRED_TOKEN).toBe("secret");
  });

  it("throws with the missing key name in the message", () => {
    expect(() =>
      loadEnv(schema, { PORT: "4310", LOG_LEVEL: "debug" }),
    ).toThrowError(/REQUIRED_TOKEN/);
  });

  it("rejects a non-numeric value for a coerced number field", () => {
    expect(() =>
      loadEnv(schema, { PORT: "not-a-number", REQUIRED_TOKEN: "secret" }),
    ).toThrowError(/PORT/);
  });
});
