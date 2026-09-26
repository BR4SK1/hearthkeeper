export type ObservationStatus = "active" | "superseded" | "retracted";

export interface CanonicalObservation {
  id: string;
  campaignId: string;
  subjectKey: string;
  kind: string;
  text: string;
  status: ObservationStatus;
  revision: number;
  revealedTo: string[];
  createdAt: string;
  updatedAt: string;
}

export class ObservationLifecycleError extends Error {}

/** Stable identity for an observation within its campaign. */
export function identityKey(
  o: Pick<CanonicalObservation, "campaignId" | "subjectKey" | "kind">,
): string {
  return `${o.campaignId}:${o.subjectKey}:${o.kind}`;
}

const LEGAL_TRANSITIONS: Record<ObservationStatus, ObservationStatus[]> = {
  active: ["superseded", "retracted"],
  superseded: ["retracted"],
  retracted: [],
};

/**
 * Lifecycle gate for the canonical-observation state machine: active →
 * superseded, active → retracted, superseded → retracted. Nothing may return
 * to active — corrections create a new active revision instead of resurrecting.
 */
export function transitionStatus(
  current: ObservationStatus,
  next: ObservationStatus,
): ObservationStatus {
  if (!LEGAL_TRANSITIONS[current].includes(next)) {
    throw new ObservationLifecycleError(
      `illegal observation transition: ${current} → ${next}`,
    );
  }
  return next;
}

export function nextRevision(current: number): number {
  return current + 1;
}
