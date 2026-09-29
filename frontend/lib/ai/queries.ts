// Read-only lookups over a snapshot, shaped small for the assistant's tools.
import { stockEntries, type StockEntry } from "@/lib/ai/facts";
import type { Fuel, Snapshot } from "@/lib/types";

const nameIndex = (s: Snapshot): ReadonlyMap<string, string> =>
  new Map([...s.depots, ...s.stations].map((e) => [e.id, e.name]));

export interface RouteSummary {
  id: string;
  from: string;
  to: string;
  status: string;
  transitMinutes: number;
  maxShipment: number;
}

export function routeSummaries(s: Snapshot, status?: string): RouteSummary[] {
  const names = nameIndex(s);
  return s.routes
    .filter((r) => status === undefined || r.status === status)
    .map((r) => ({
      id: r.id,
      from: names.get(r.source_depot_id) ?? r.source_depot_id,
      to: names.get(r.destination_station_id) ?? r.destination_station_id,
      status: r.status,
      transitMinutes: r.transit_ticks * s.instance.tick_minutes,
      maxShipment: r.max_shipment,
    }));
}

export interface EventSummary {
  id: number;
  type: string;
  status: string;
  startTick: number;
  endTick: number;
}

export function eventSummaries(s: Snapshot): EventSummary[] {
  return s.events.map((e) => ({
    id: e.id,
    type: e.type,
    status: e.status,
    startTick: e.start_tick,
    endTick: e.end_tick,
  }));
}

export interface AllocationSummary {
  id: number;
  from: string;
  to: string;
  fuel: Fuel;
  quantity: number;
  status: string;
  createdTick: number;
}

export function allocationSummaries(s: Snapshot, status?: string, limit = 10): AllocationSummary[] {
  const names = nameIndex(s);
  return s.allocations
    .filter((a) => status === undefined || a.status === status)
    .sort((a, b) => b.id - a.id)
    .slice(0, limit)
    .map((a) => ({
      id: a.id,
      from: names.get(a.source_depot_id) ?? a.source_depot_id,
      to: names.get(a.destination_station_id) ?? a.destination_station_id,
      fuel: a.fuel_type,
      quantity: a.quantity,
      status: a.status,
      createdTick: a.created_tick,
    }));
}

export function stockFor(s: Snapshot, id: string): StockEntry[] {
  return stockEntries(s).filter((e) => e.id === id);
}
