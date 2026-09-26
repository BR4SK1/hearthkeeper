/**
 * The no-LLM recall path: weighted-text retrieval plus in-process arithmetic
 * scoring only. No vector keys, no embedding calls, no model inference
 * anywhere in this module.
 */
export interface RecallQuery {
  campaignId: string;
  text: string;
  kind?: string;
  characterBudget?: number;
}

export function buildRecallFilter(q: RecallQuery): Record<string, unknown> {
  // Campaign-scoped, active-only, weighted $text — recall is weighted-text
  // + in-process scoring only.
  return {
    campaignId: q.campaignId,
    status: "active",
    ...(q.kind ? { kind: q.kind } : {}),
    $text: { $search: q.text },
  };
}

/** Lowercase word tokens for matching and scoring. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * In-process arithmetic scoring: count how many query tokens occur in the
 * candidate text, weighted by token length so longer (more specific) matches
 * count for more. Pure function, no I/O, no model calls.
 */
export function scoreCandidate(candidateText: string, queryTokens: string[]): number {
  const candidate = candidateText.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (!candidate.includes(token)) {
      continue;
    }
    // Every occurrence contributes; a token occurring multiple times in the
    // candidate scores higher than one appearing once.
    let occurrences = 0;
    let index = candidate.indexOf(token);
    while (index !== -1) {
      occurrences += 1;
      index = candidate.indexOf(token, index + token.length);
    }
    score += occurrences * token.length;
  }
  return score;
}

/** Score and sort candidates by descending relevance. */
export function rankCandidates<T extends { text: string }>(
  candidates: T[],
  query: string,
): Array<T & { score: number }> {
  const queryTokens = tokenize(query);
  return candidates
    .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate.text, queryTokens) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Trim to a character budget: take items in order while the cumulative text
 * length plus the next item's length fits. The first item is always included,
 * even when it alone exceeds the budget, so recall never returns empty for a
 * matching query.
 */
export function applyCharacterBudget<T extends { text: string }>(items: T[], budget: number): T[] {
  const kept: T[] = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i > 0 && used + item.text.length > budget) {
      break;
    }
    kept.push(item);
    used += item.text.length;
  }
  return kept;
}
