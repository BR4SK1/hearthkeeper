import { describe, expect, it } from "vitest";
import { createNdjsonLineSplitter, parseNdjsonEvent } from "./ndjson.js";

const FOUR_LINES = '{"type":"ack"}\n{"type":"beat","i":0}\n\n{"type":"done"}\n{"type":"error"}\n';

describe("createNdjsonLineSplitter", () => {
  it("yields the same lines no matter where chunks cut the payload", () => {
    for (let cut = 0; cut <= FOUR_LINES.length; cut++) {
      const nextLine = createNdjsonLineSplitter();
      const lines = [
        ...nextLine(FOUR_LINES.slice(0, cut)),
        ...nextLine(FOUR_LINES.slice(cut)),
        ...nextLine("\n"), // end-of-stream flush for any trailing partial
      ];
      expect(lines).toEqual(['{"type":"ack"}', '{"type":"beat","i":0}', '{"type":"done"}', '{"type":"error"}']);
    }
  });

  it("handles multi-line chunks and blank lines", () => {
    const nextLine = createNdjsonLineSplitter();
    expect(nextLine('{"a":1}\n{"b":2}\n\n{"c":3}\n')).toEqual([
      '{"a":1}',
      '{"b":2}',
      '{"c":3}',
    ]);
  });

  it("buffers a trailing partial line until the flush", () => {
    const nextLine = createNdjsonLineSplitter();
    expect(nextLine('{"partial":')).toEqual([]);
    expect(nextLine('1}')).toEqual([]); // still no newline — stays buffered
    expect(nextLine("\n")).toEqual(['{"partial":1}']);
  });

  it("drops \r in CRLF payloads", () => {
    const nextLine = createNdjsonLineSplitter();
    expect(nextLine('{"a":1}\r\n{"b":2}\r\n')).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("parseNdjsonEvent", () => {
  it("parses a typed event", () => {
    expect(parseNdjsonEvent<{ type: string }>('{"type":"ack"}')).toEqual({ type: "ack" });
  });

  it("throws on an empty line", () => {
    expect(() => parseNdjsonEvent("   ")).toThrowError(/empty/);
  });
});