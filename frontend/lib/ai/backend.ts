import { assessQuality, HEALTHY_DATA, type LoadedState } from "@/lib/ai/quality";
import { isScenario, mockSnapshot, type Scenario } from "@/lib/mock/scenarios";
import type { StateResponse, StatusResponse } from "@/lib/types";

// Server-side base URL of the Go API. Same variable next.config.ts uses for the /api proxy.
const API_BASE = process.env.API_PROXY_TARGET ?? "http://api:8000";
const TIMEOUT_MS = 3000;
// The explain endpoint makes a live LLM call (~4-6s), so it needs a longer
// budget than the fast read endpoints. Kept under the chat route's 30s cap.
const EXPLAIN_TIMEOUT_MS = 25000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function getJSON<T>(fetchImpl: FetchLike, path: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  const res = await fetchImpl(`${API_BASE}${path}`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
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

// A recommendation as the assistant needs to refer to it: enough to name it and
// pick an id to explain. The full evidence lives behind explainRecommendation.
export interface RecommendationSummary {
  id: number;
  station_id: string;
  fuel_type: string;
  quantity: number;
  verdict: string;
  status: string;
  risk_before: number | null;
  risk_after: number | null;
}

// The backend's guarded decision explanation (internal/genai): the hard numbers
// are computed server-side, the narrative is grounded and verified there.
export interface DecisionExplanation {
  headline: string;
  narrative: string;
  factors: string[];
  confidence: string;
  action: string;
  source: "llm" | "rule-based";
}

// The list endpoint returns more fields than we need; we read only these.
interface RecListResponse {
  recommendations: RecommendationSummary[];
}

// listRecommendations reads the current recommendations from the Go API. In a
// scenario preview there is no live decision pipeline, so it returns [].
export async function listRecommendations(
  scenario: Scenario | undefined,
  opts: { status?: string; limit?: number } = {},
  fetchImpl: FetchLike = fetch,
): Promise<RecommendationSummary[]> {
  if (isScenario(scenario)) return [];
  const q = new URLSearchParams();
  if (opts.status) q.set("status", opts.status);
  q.set("limit", String(opts.limit ?? 20));
  const res = await getJSON<RecListResponse>(fetchImpl, `/api/recommendations?${q.toString()}`);
  return res.recommendations.map((r) => ({
    id: r.id,
    station_id: r.station_id,
    fuel_type: r.fuel_type,
    quantity: r.quantity,
    verdict: r.verdict,
    status: r.status,
    risk_before: r.risk_before ?? null,
    risk_after: r.risk_after ?? null,
  }));
}

// explainRecommendation asks the Go API for the guarded explanation of one
// recommendation. The narrative/numbers come from the backend, not this route.
export async function explainRecommendation(
  scenario: Scenario | undefined,
  id: number,
  fetchImpl: FetchLike = fetch,
): Promise<DecisionExplanation> {
  if (isScenario(scenario)) {
    throw new Error("Explanations are only available on live data, not in a scenario preview.");
  }
  const res = await getJSON<{ explanation: DecisionExplanation }>(
    fetchImpl,
    `/api/recommendations/${encodeURIComponent(String(id))}/explain`,
    EXPLAIN_TIMEOUT_MS,
  );
  return res.explanation;
}
