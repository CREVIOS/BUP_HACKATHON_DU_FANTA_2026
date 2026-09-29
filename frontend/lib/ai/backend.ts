import { assessQuality, HEALTHY_DATA, type LoadedState } from "@/lib/ai/quality";
import { isScenario, mockSnapshot, type Scenario } from "@/lib/mock/scenarios";
import type { StateResponse, StatusResponse } from "@/lib/types";

// Server-side base URL of the Go API. Same variable next.config.ts uses for the /api proxy.
const API_BASE = process.env.API_PROXY_TARGET ?? "http://api:8000";
const TIMEOUT_MS = 3000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function getJSON<T>(fetchImpl: FetchLike, path: string): Promise<T> {
  const res = await fetchImpl(`${API_BASE}${path}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

// The single source of facts for every AI feature: the latest stored snapshot plus how far to trust
// it, or a mock world. The state call must succeed; the health call may fail, which is reported as
// "could not confirm" rather than assumed healthy.
export async function loadContext(
  scenario: Scenario | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<LoadedState> {
  if (isScenario(scenario)) return { snapshot: mockSnapshot(scenario), quality: HEALTHY_DATA };

  const [state, status] = await Promise.allSettled([
    getJSON<StateResponse>(fetchImpl, "/api/state"),
    getJSON<StatusResponse>(fetchImpl, "/api/status"),
  ]);
  if (state.status === "rejected") throw state.reason;
  if (!state.value.snapshot) throw new Error("No simulator snapshot is available yet.");
  return {
    snapshot: state.value.snapshot,
    quality: assessQuality(state.value, status.status === "fulfilled" ? status.value : undefined),
  };
}
