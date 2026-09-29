export interface TtlCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

// Tiny time-based cache. Bounded, so a stream of distinct keys cannot grow memory.
export function createTtlCache<T>(options: { ttlMs: number; maxEntries?: number; now?: () => number }): TtlCache<T> {
  const { ttlMs, maxEntries = 20, now = Date.now } = options;
  const entries = new Map<string, { value: T; at: number }>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      entries.delete(key); // keep insertion order = age order
      entries.set(key, { value, at: now() });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}
