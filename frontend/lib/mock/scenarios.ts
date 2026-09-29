// Hand-built test world for the AI unit tests: the real baseline snapshot pushed into a crisis
// (low stock, a disrupted route, a failed allocation). Test-only; the app always uses live data.
import { BASELINE } from "@/lib/mock/baseline";
import type { Snapshot, Station } from "@/lib/types";

const STATION_OVERRIDES: Record<string, Pick<Station, "inventory"> & Partial<Pick<Station, "status">>> = {
  "station-mirpur": { inventory: { DIESEL: 2100, PETROL: 3400, OCTANE: 4100 } },
  "station-tongi": { inventory: { DIESEL: 5200, PETROL: 4600, OCTANE: 2900 } },
  "station-karnaphuli": { inventory: { DIESEL: 7800, PETROL: 3300, OCTANE: 4300 } },
};

const CRISIS_DEPOT_INVENTORY: Record<string, Snapshot["depots"][number]["inventory"]> = {
  "depot-gazipur": { DIESEL: 41000, PETROL: 30500, OCTANE: 19800 },
  "depot-patiya": { DIESEL: 38200, PETROL: 27400, OCTANE: 15600 },
};

export function crisisSnapshot(): Snapshot {
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
