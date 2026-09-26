/**
 * Small in-memory wav cache: filler wavs (loaded at boot) plus one entry
 * per synthesized narration beat, keyed by the ids the wire contract
 * exposes ("fill-<fillerId>", "t<turnId>-<i>"). Capped at maxEntries with
 * oldest-inserted eviction — clients fetch audio shortly after the event
 * arrives, so the window only needs to span a few turns.
 */
export class WavCache {
  private readonly entries = new Map<string, Buffer>();
  private readonly insertionOrder: string[] = [];

  constructor(private readonly maxEntries = 64) {}

  put(key: string, value: Buffer): void {
    if (!this.entries.has(key)) {
      this.insertionOrder.push(key);
    }
    this.entries.set(key, value);
    while (this.insertionOrder.length > this.maxEntries) {
      const oldest = this.insertionOrder.shift();
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  get(key: string): Buffer | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }
}
