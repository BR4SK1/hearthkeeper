import type { Db } from "mongodb";
import type { IndexSpec } from "./indexSpec.js";
import { MEMORY_INDEXES } from "./indexSpec.js";

/**
 * Creates every index in the spec. createIndex is idempotent for identical
 * specs (same keys and options): MongoDB returns the existing index name
 * instead of rebuilding, so this is safe to run at every boot.
 */
export async function ensureIndexes(db: Db, specs: IndexSpec[] = MEMORY_INDEXES): Promise<void> {
  for (const spec of specs) {
    const { name, weights, unique } = spec.options;
    await db.collection(spec.collection).createIndex(spec.keys, {
      name,
      ...(weights !== undefined ? { weights } : {}),
      ...(unique !== undefined ? { unique } : {}),
    });
  }
}
