/**
 * Incremental NDJSON line splitting for streamed fetch bodies: chunks from
 * the reader may split a line anywhere (mid-JSON) or carry several lines at
 * once. The splitter buffers the trailing partial line across calls and
 * emits only complete, non-empty lines; a final call with a newline (or the
 * end-of-stream flush in api.ts) releases it.
 */
export function createNdjsonLineSplitter(): (chunk: string) => string[] {
  let buffer = "";
  return (chunk: string): string[] => {
    buffer += chunk;
    const lines: string[] = [];
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) lines.push(line);
      newline = buffer.indexOf("\n");
    }
    return lines;
  };
}

/** Parse one NDJSON line as JSON; throws on empty/blank lines. */
export function parseNdjsonEvent<T>(line: string): T {
  if (line.trim().length === 0) {
    throw new Error("cannot parse an empty ndjson line");
  }
  return JSON.parse(line) as T;
}