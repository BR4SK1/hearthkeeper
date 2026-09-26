export interface SessionRecap {
  campaignId: string;
  sessionNumber: number;
  text: string;
  superseded: boolean;
}

/**
 * Recap serving gate: among non-superseded recaps with sessionNumber <= the
 * requested number, serve the highest sessionNumber. Recaps are gated so a
 * rewrite (new recap for the same session superseding the old) never serves
 * stale text, and a recap for a session that has not happened yet is never
 * served ahead of time.
 */
export function servableRecap(
  recaps: SessionRecap[],
  sessionNumber: number,
): SessionRecap | null {
  const eligible = recaps.filter(
    (r) => !r.superseded && r.sessionNumber <= sessionNumber,
  );
  if (eligible.length === 0) {
    return null;
  }
  return eligible.reduce((best, current) =>
    current.sessionNumber > best.sessionNumber ? current : best,
  );
}
