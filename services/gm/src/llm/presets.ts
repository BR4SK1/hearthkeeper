/**
 * Task-preset configuration: each LLM task type gets a fixed temperature and
 * token budget so behavior is stable per task instead of tuned per call site.
 * The narration budget is overridable (GM_MAX_TOKENS backstop); the other
 * tasks keep their fixed budgets.
 */
export type TaskName = "narration" | "classification" | "recap";

export interface TaskPreset {
  model: string;
  temperature: number;
  maxTokens: number;
}

export function buildPresets(
  model: string,
  opts: { narrationMaxTokens?: number } = {},
): Record<TaskName, TaskPreset> {
  return {
    narration: { model, temperature: 0.9, maxTokens: opts.narrationMaxTokens ?? 700 },
    classification: { model, temperature: 0, maxTokens: 200 },
    recap: { model, temperature: 0.7, maxTokens: 900 },
  };
}
