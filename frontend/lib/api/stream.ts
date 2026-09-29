import { keys, type QueryKey } from "@/lib/api/keys";

// What each /api/stream event changes (docs/API.md section 6).
const MAP: Record<string, readonly QueryKey[]> = {
  tick: [keys.overview, keys.network, keys.risk, keys.demandAll, keys.supply, keys.events, keys.intelQuality, keys.rl, keys.rlShadowAll],
  alerts: [keys.alertsAll, keys.overview],
  recommendations: [keys.recommendationsAll, keys.decisions, keys.overview],
  allocations: [keys.allocations, keys.rlShadowAll],
  commands: [keys.commands],
};

export const STREAM_EVENTS = Object.keys(MAP);

export function invalidationsFor(event: string): QueryKey[] {
  return [...(MAP[event] ?? [])];
}

// A running simulator emits several ticks a second. Collect the keys and refresh each once per window,
// so a burst of events never turns into a storm of requests.
export function createInvalidator(invalidate: (key: QueryKey) => void, windowMs = 500) {
  const pending = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (event: string) => {
    for (const key of invalidationsFor(event)) pending.set(JSON.stringify(key), key);
    if (timer !== undefined || pending.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      const batch = [...pending.values()];
      pending.clear();
      batch.forEach(invalidate);
    }, windowMs);
  };
}

// EventSource gives up for good when the server answers with anything but an event stream (for
// example a 502 while the API is down), so the caller reconnects itself with this backoff.
export function reconnectDelay(attempt: number): number {
  return Math.min(30_000, 3_000 * 2 ** attempt);
}
