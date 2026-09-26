/**
 * The push-to-talk conch/handoff model: the party holds
 * the conch, hands it off, the GM acknowledges while thinking, then narrates.
 * Pure state machine — no persistence, no I/O; wiring is Phase 4 work.
 *
 * listening→narrating directly is illegal on purpose: the mic is closed while
 * the GM speaks, so the turn must pass through handoff→ack→narration, which
 * is also where the canned filler audio plays.
 */
export type SessionState = "idle" | "listening" | "handoff" | "thinking" | "narrating";

export type SessionEvent =
  | "conchTaken"
  | "partyDone"
  | "ack"
  | "narrationStart"
  | "narrationEnd"
  | "sessionEnd";

export class SessionStateError extends Error {}

const TRANSITIONS: Record<SessionState, Partial<Record<SessionEvent, SessionState>>> = {
  idle: {
    conchTaken: "listening",
    sessionEnd: "idle",
  },
  listening: {
    partyDone: "handoff",
    sessionEnd: "idle",
  },
  handoff: {
    ack: "thinking",
    sessionEnd: "idle",
  },
  thinking: {
    narrationStart: "narrating",
    sessionEnd: "idle",
  },
  narrating: {
    narrationEnd: "listening",
    sessionEnd: "idle",
  },
};

export class SessionStateMachine {
  private currentState: SessionState;

  constructor(initial: SessionState = "idle") {
    this.currentState = initial;
  }

  get state(): SessionState {
    return this.currentState;
  }

  can(event: SessionEvent): boolean {
    return TRANSITIONS[this.currentState][event] !== undefined;
  }

  transition(event: SessionEvent): SessionState {
    const next = TRANSITIONS[this.currentState][event];
    if (next === undefined) {
      throw new SessionStateError(
        `illegal session transition: ${event} from ${this.currentState}`,
      );
    }
    this.currentState = next;
    return this.currentState;
  }

  /**
   * Escape hatch for turn-failure reconciliation only: any state → idle,
   * never throws. Transitions stay strict; callers must treat reset as the
   * last resort after a failed turn, not as part of the happy path.
   */
  reset(): void {
    this.currentState = "idle";
  }
}
