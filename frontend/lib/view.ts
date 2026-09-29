import type { FuelCellData, InventoryRow } from "@/components/inventory-table";
import type { Fuel, Network } from "@/lib/api/schemas";

export interface NetworkView {
  names: ReadonlyMap<string, string>; // depot/station id -> display name
  depots: InventoryRow[];
  stations: InventoryRow[];
}

const isFuel = (key: string): key is Fuel => key === "DIESEL" || key === "PETROL" || key === "OCTANE";

function fuelsOf<T>(fuels: Record<string, T>, map: (value: T) => FuelCellData): InventoryRow["fuels"] {
  return Object.fromEntries(Object.entries(fuels).flatMap(([fuel, value]) => (isFuel(fuel) ? [[fuel, map(value)]] : [])));
}

export function deriveNetworkView(network: Network): NetworkView {
  const regions = new Map(network.regions.map((r) => [r.id, r.name]));
  const region = (id: string) => regions.get(id) ?? id;
  const depots = network.depots.map((d) => ({
    id: d.id,
    name: d.name,
    region: region(d.region_id),
    status: d.status,
    fuels: fuelsOf(d.fuels, (f) => ({ inventory: f.inventory, capacity: f.capacity, fill: f.fill })),
  }));
  const stations = network.stations.map((s) => ({
    id: s.id,
    name: s.name,
    region: region(s.region_id),
    status: s.status,
    fuels: fuelsOf(s.fuels, (f) => ({
      inventory: f.inventory,
      capacity: f.capacity,
      fill: f.fill,
      risk: f.risk_level,
      hoursToStockout: f.time_to_stockout_hours,
    })),
  }));
  const names = new Map([...depots, ...stations].map((row) => [row.id, row.name]));
  return { names, depots, stations };
}
