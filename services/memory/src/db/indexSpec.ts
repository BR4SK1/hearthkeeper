/**
 * Index specifications for the campaign memory store. The recall path is
 * weighted-text search plus in-process scoring — there is deliberately NO
 * vector index anywhere in this store.
 */
export interface IndexSpec {
  collection: string;
  keys: Record<string, 1 | -1 | "text">;
  options: {
    name: string;
    weights?: Record<string, number>;
    unique?: boolean;
  };
}

export const MEMORY_INDEXES: IndexSpec[] = [
  {
    collection: "observations",
    keys: { campaignId: 1, subjectKey: 1, status: 1 },
    options: { name: "obs_by_campaign_subject_status" },
  },
  {
    collection: "observations",
    keys: { campaignId: 1, status: 1, updatedAt: -1 },
    options: { name: "obs_by_campaign_status_recent" },
  },
  {
    collection: "observations",
    keys: { text: "text", subjectKey: "text" },
    options: {
      name: "obs_text_search",
      weights: { text: 3, subjectKey: 2 },
    },
  },
  {
    collection: "recaps",
    keys: { campaignId: 1, sessionNumber: -1 },
    options: { name: "recaps_by_campaign_session" },
  },
  {
    collection: "ingest_events",
    keys: { campaignId: 1, seq: -1 },
    options: { name: "ingest_by_campaign_seq" },
  },
];
