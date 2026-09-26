/**
 * Async ingest with watermarking. The ingest queue and its worker are Phase 4
 * work; the job boundary and watermark arithmetic land now so the transport
 * can be designed against a stable shape.
 */
export interface IngestWatermark {
  campaignId: string;
  lastAppliedSeq: number;
}

export class IngestWatermarkError extends Error {}

/**
 * Monotonic watermark advance: never regresses. An observed seq older than
 * the current watermark is a replay and is ignored (the current watermark
 * stands); a negative seq is malformed input and throws.
 */
export function advanceWatermark(current: number, observed: number): number {
  if (observed < 0) {
    throw new IngestWatermarkError(`negative ingest seq: ${observed}`);
  }
  return Math.max(current, observed);
}

export interface IngestJob {
  campaignId: string;
  seq: number;
  kind: "observation" | "recap";
  payload: unknown;
}
