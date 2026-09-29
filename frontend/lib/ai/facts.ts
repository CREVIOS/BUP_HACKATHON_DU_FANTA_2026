// Numbers the assistant is allowed to quote. Code computes them; the model only narrates them.
import { HEALTHY_DATA, type DataQuality } from "@/lib/ai/quality";
import { fillRatio, stockLevel, type StockLevel } from "@/lib/format";
import { FUELS, type Fuel, type Snapshot } from "@/lib/types";

export interface StockEntry {
  kind: "depot" | "station";
  id: string;
  name: string;
  region: string;
  fuel: Fuel;
  inventory: number;
  capacity: number;
  percent: number; // whole number, 0 to 100+
  level: StockLevel;
}

function nameIndex(snapshot: Snapshot): ReadonlyMap<string, string> {
  return new Map([...snapshot.depots, ...snapshot.stations].map((e) => [e.id, e.name]));
}

export function stockEntries(snapshot: Snapshot): StockEntry[] {
  const regions = new Map(snapshot.regions.map((r) => [r.id, r.name]));
  const rows = [
    ...snapshot.depots.map((e) => ({ kind: "depot" as const, e })),
    ...snapshot.stations.map((e) => ({ kind: "station" as const, e })),
  ];
  return rows.flatMap(({ kind, e }) =>
    FUELS.flatMap((fuel) => {
      const inventory = e.inventory[fuel];
      const capacity = e.capacity[fuel];
      const ratio = fillRatio(inventory, capacity);
      if (ratio === null || inventory === undefined || capacity === undefined) return [];
      return [
        {
          kind,
          id: e.id,
          name: e.name,
          region: regions.get(e.region_id) ?? e.region_id,
          fuel,
          inventory,
          capacity,
          percent: Math.round(ratio * 100),
          level: stockLevel(ratio),
        },
      ];
    }),
  );
}

// Entries at or below maxPercent of capacity, emptiest first.
export function lowStock(snapshot: Snapshot, maxPercent = 40): StockEntry[] {
  return stockEntries(snapshot)
    .filter((entry) => entry.percent <= maxPercent)
    .sort((a, b) => a.percent - b.percent);
}

export interface NetworkFacts {
  tick: number;
  runState: string;
  serviceLevel?: number;
  unmetLiters?: number;
  allocationFailures?: number;
  disruptedRoutes: { id: string; from: string; to: string }[];
  outageStations: string[];
  activeEvents: { type: string; startTick: number; endTick: number }[];
  delayedSupply: { depot: string; fuel: Fuel; quantity: number; plannedTick: number }[];
  allocationsByStatus: Record<string, number>;
  dataQuality: DataQuality;
}

export function networkFacts(snapshot: Snapshot, quality: DataQuality = HEALTHY_DATA): NetworkFacts {
  const names = nameIndex(snapshot);
  const nameOf = (id: string) => names.get(id) ?? id;
  const allocationsByStatus: Record<string, number> = {};
  for (const a of snapshot.allocations) {
    allocationsByStatus[a.status] = (allocationsByStatus[a.status] ?? 0) + 1;
  }
  return {
    tick: snapshot.instance.tick,
    runState: snapshot.instance.status,
    serviceLevel: snapshot.metrics?.service_level,
    unmetLiters: snapshot.metrics?.unmet_demand_liters,
    allocationFailures: snapshot.metrics?.allocation_failures,
    disruptedRoutes: snapshot.routes
      .filter((r) => r.status === "DISRUPTED")
      .map((r) => ({ id: r.id, from: nameOf(r.source_depot_id), to: nameOf(r.destination_station_id) })),
    outageStations: snapshot.stations.filter((s) => s.status === "OUTAGE").map((s) => s.name),
    activeEvents: snapshot.events
      .filter((e) => e.status === "ACTIVE")
      .map((e) => ({ type: e.type, startTick: e.start_tick, endTick: e.end_tick })),
    delayedSupply: snapshot.supply_arrivals
      .filter((s) => s.status === "DELAYED")
      .map((s) => ({ depot: nameOf(s.depot_id), fuel: s.fuel_type, quantity: s.quantity, plannedTick: s.planned_tick })),
    allocationsByStatus,
    dataQuality: quality,
  };
}
