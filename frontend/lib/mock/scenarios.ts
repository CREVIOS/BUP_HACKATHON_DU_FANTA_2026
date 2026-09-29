// Mock worlds for UI work and tests. Built from the real baseline snapshot so the shape is exact.
import demoState from "@/lib/api/__fixtures__/state.json";
import demoStatus from "@/lib/api/__fixtures__/status.json";
import { BASELINE } from "@/lib/mock/baseline";
import type { Snapshot, StateResponse, Station } from "@/lib/types";

// "demo": a real API capture (same world as the dashboard's mock mode). "crisis": hand-built for tests.
export const SCENARIOS = ["demo", "crisis"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export function isScenario(value: unknown): value is Scenario {
  return typeof value === "string" && (SCENARIOS as readonly string[]).includes(value);
}

const STATION_OVERRIDES: Record<string, Pick<Station, "inventory"> & Partial<Pick<Station, "status">>> = {
  "station-mirpur": { inventory: { DIESEL: 2100, PETROL: 3400, OCTANE: 4100 } },
  "station-tongi": { inventory: { DIESEL: 5200, PETROL: 4600, OCTANE: 2900 } },
  "station-karnaphuli": { inventory: { DIESEL: 7800, PETROL: 3300, OCTANE: 4300 } },
};

const CRISIS_DEPOT_INVENTORY: Record<string, Snapshot["depots"][number]["inventory"]> = {
  "depot-gazipur": { DIESEL: 41000, PETROL: 30500, OCTANE: 19800 },
  "depot-patiya": { DIESEL: 38200, PETROL: 27400, OCTANE: 15600 },
};

function crisisSnapshot(): Snapshot {
  return {
    ...BASELINE,
    instance: {
      ...BASELINE.instance,
      tick: 148,
      status: "RUNNING",
      sim_time: "2026-01-02T13:00:00",
      scenario_id: "final_combined",
    },
    depots: BASELINE.depots.map((d) => ({ ...d, inventory: CRISIS_DEPOT_INVENTORY[d.id] ?? d.inventory })),
    stations: BASELINE.stations.map((s) => ({ ...s, ...STATION_OVERRIDES[s.id] })),
    routes: BASELINE.routes.map((r) => (r.id === "route-gazipur-mirpur" ? { ...r, status: "DISRUPTED" } : r)),
    events: [
      { id: 1, type: "route_disruption", start_tick: 144, end_tick: 172, status: "ACTIVE" },
      { id: 2, type: "demand_spike", start_tick: 140, end_tick: 180, status: "ACTIVE" },
    ],
    allocations: [
      { id: 40, source_depot_id: "depot-gazipur", destination_station_id: "station-tongi", fuel_type: "DIESEL", quantity: 6000, created_tick: 130, status: "ARRIVED" },
      { id: 41, source_depot_id: "depot-gazipur", destination_station_id: "station-tongi", fuel_type: "DIESEL", quantity: 6000, created_tick: 142, status: "IN_TRANSIT" },
      { id: 42, source_depot_id: "depot-patiya", destination_station_id: "station-mirpur", fuel_type: "DIESEL", quantity: 5000, created_tick: 145, status: "IN_TRANSIT" },
      { id: 43, source_depot_id: "depot-gazipur", destination_station_id: "station-mirpur", fuel_type: "PETROL", quantity: 4000, created_tick: 144, status: "FAILED" },
      { id: 44, source_depot_id: "depot-patiya", destination_station_id: "station-karnaphuli", fuel_type: "PETROL", quantity: 3000, created_tick: 147, status: "PENDING" },
    ],
    supply_arrivals: BASELINE.supply_arrivals.map((s, i) => (i === 0 ? { ...s, status: "DELAYED" } : s)),
    metrics: { service_level: 0.943, unmet_demand_liters: 18450, allocation_failures: 1 },
  };
}

export function mockSnapshot(scenario: Scenario): Snapshot {
  switch (scenario) {
    case "demo":
      return structuredClone(demoState.snapshot) as unknown as Snapshot;
    case "crisis":
      return crisisSnapshot();
  }
}

// /api/status as captured with the demo world.
export const DEMO_STATUS: Record<string, string | number> = demoStatus;

export function mockState(scenario: Scenario): StateResponse {
  return {
    tick: mockSnapshot(scenario).instance.tick,
    stale: false,
    captured_at: "2026-01-02T13:00:00Z",
    age_seconds: 0,
    snapshot: mockSnapshot(scenario),
  };
}

// Health panel values for mock mode (same shape as GET /api/status).
export const MOCK_STATUS: Record<string, string | number> = {
  backend_api: "healthy",
  database: "healthy",
  fuel_simulator: "healthy",
  prediction_service: "healthy",
  decision_engine: "degraded: fallback policy active (intel timed out)",
  jev: "disabled: fixed review rule only",
  p95_latency_ms: 14.2,
  error_rate: 0.004,
  requests_5m: 812,
};
