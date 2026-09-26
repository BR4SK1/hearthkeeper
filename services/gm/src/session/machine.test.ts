import { describe, expect, it } from "vitest";
import { SessionStateMachine, SessionStateError } from "./machine.js";

describe("SessionStateMachine", () => {
  it("walks the full happy path", () => {
    const machine = new SessionStateMachine();
    expect(machine.state).toBe("idle");
    expect(machine.transition("conchTaken")).toBe("listening");
    expect(machine.transition("partyDone")).toBe("handoff");
    expect(machine.transition("ack")).toBe("thinking");
    expect(machine.transition("narrationStart")).toBe("narrating");
    expect(machine.transition("narrationEnd")).toBe("listening");
  });

  it("rejects listening → narrating (mic closed while the GM speaks)", () => {
    const machine = new SessionStateMachine("listening");
    expect(() => machine.transition("narrationStart")).toThrowError(SessionStateError);
  });

  it("rejects idle → handoff", () => {
    const machine = new SessionStateMachine();
    expect(() => machine.transition("partyDone")).toThrowError(SessionStateError);
  });

  it("sessionEnd returns to idle from narrating", () => {
    const machine = new SessionStateMachine("narrating");
    expect(machine.transition("sessionEnd")).toBe("idle");
  });

  it("sessionEnd is legal from every state", () => {
    for (const state of ["idle", "listening", "handoff", "thinking", "narrating"] as const) {
      const machine = new SessionStateMachine(state);
      expect(machine.transition("sessionEnd")).toBe("idle");
    }
  });
});
