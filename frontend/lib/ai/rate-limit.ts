// Small in-memory sliding-window limiter. Per process: with several replicas the effective limit
// is limit x replicas, which is fine as a cost guard for an LLM endpoint.
export interface RateLimiter {
  allow(key: string): boolean;
  size(): number;
}

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}): RateLimiter {
  const { limit, windowMs, maxKeys = 500, now = Date.now } = options;
  const hits = new Map<string, number[]>();

  function prune(at: number) {
    for (const [key, times] of hits) {
      if (times.every((t) => at - t >= windowMs)) hits.delete(key);
    }
    // Still too many live keys: drop the oldest inserted ones.
    while (hits.size > maxKeys) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) break;
      hits.delete(oldest);
    }
  }

  return {
    allow(key) {
      const at = now();
      const recent = (hits.get(key) ?? []).filter((t) => at - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      hits.delete(key); // re-insert so insertion order tracks recency
      hits.set(key, [...recent, at]);
      if (hits.size > maxKeys) prune(at);
      return true;
    },
    size: () => hits.size,
  };
}
