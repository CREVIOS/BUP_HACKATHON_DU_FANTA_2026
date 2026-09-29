// Mirrors the JSON the Go API serves (backend/internal/sim/types.go and internal/api).

export type Fuel = "DIESEL" | "PETROL" | "OCTANE";
export const FUELS: readonly Fuel[] = ["DIESEL", "PETROL", "OCTANE"];
export type FuelMap = Partial<Record<Fuel, number>>;

export interface Instance {
  tick: number;
  status: string; // PAUSED | RUNNING
  sim_time: string; // naive timestamp, UTC
  scenario_id: string;
  tick_minutes: number;
}

export interface Region {
  id: string;
  name: string;
  demand_factor: number;
}

export interface Depot {
  id: string;
  name: string;
  region_id: string;
  status: string; // OPEN | CONSTRAINED
  dispatch_capacity_per_tick: number;
  capacity: FuelMap;
  inventory: FuelMap;
}

export interface Station {
  id: string;
  name: string;
  region_id: string;
  status: string; // OPEN | OUTAGE
  demand_profile: string;
  demand_multiplier: number;
  capacity: FuelMap;
  inventory: FuelMap;
}

export interface Route {
  id: string;
  source_depot_id: string;
  destination_station_id: string;
  transit_ticks: number;
  max_shipment: number;
  status: string; // AVAILABLE | DISRUPTED
}

export interface SimEvent {
  id: number;
  type: string;
  start_tick: number;
  end_tick: number;
  status: string; // SCHEDULED | ACTIVE | RESOLVED
}

export interface Allocation {
  id: number;
  source_depot_id: string;
  destination_station_id: string;
  fuel_type: Fuel;
  quantity: number;
  created_tick: number;
  status: string; // PENDING | IN_TRANSIT | ARRIVED | FAILED | CANCELLED
}

export interface SupplyArrival {
  id: string;
  depot_id: string;
  fuel_type: Fuel;
  quantity: number;
  planned_tick: number;
  actual_tick?: number | null;
  status: string; // SCHEDULED | DELAYED | ARRIVED
}

export interface SimMetrics {
  service_level: number;
  unmet_demand_liters: number;
  allocation_failures: number;
}

export interface Snapshot {
  instance: Instance;
  regions: Region[];
  depots: Depot[];
  stations: Station[];
  routes: Route[];
  events: SimEvent[];
  allocations: Allocation[];
  supply_arrivals: SupplyArrival[];
  metrics?: SimMetrics;
}

// GET /api/state. Before the first poll the API answers { tick: null }.
export interface StateResponse {
  tick: number | null;
  stale?: boolean;
  captured_at?: string;
  age_seconds?: number;
  snapshot?: Snapshot;
}

// GET /api/status: component -> "healthy" | "degraded: <why>" | "unhealthy: <why>", plus request metrics.
export type StatusResponse = Record<string, string | number | undefined>;
