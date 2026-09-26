import { describe, expect, it } from "vitest";
import { appendTurnBeat, updateTurnBeat, type LogEntry } from "./chatLog.js";

const beat = (text: string, revealed = 0) => ({
  segments: [{ type: "text" as const, value: text }],
  revealed,
  degraded: false,
});

describe("turn-scoped chat log updates", () => {
  it("keeps a previous turn fully revealed while appending and revealing the next turn", () => {
    let log: LogEntry[] = appendTurnBeat([], "turn-1", beat("First scene.", 12));
    log = [...log, { kind: "party", text: "What happens next?" }];
    log = appendTurnBeat(log, "turn-2", beat("Second scene."));
    log = updateTurnBeat(log, "turn-2", 0, { revealed: 6 });

    expect(log.filter((entry) => entry.kind === "gm")).toEqual([
      { kind: "gm", turnId: "turn-1", beats: [beat("First scene.", 12)] },
      { kind: "gm", turnId: "turn-2", beats: [beat("Second scene.", 6)] },
    ]);
  });

  it("ignores reveal updates for an unknown turn or beat", () => {
    const log = appendTurnBeat([], "turn-1", beat("First scene."));
    expect(updateTurnBeat(log, "turn-2", 0, { revealed: 10 })).toBe(log);
    expect(updateTurnBeat(log, "turn-1", 3, { revealed: 10 })).toBe(log);
  });
});
