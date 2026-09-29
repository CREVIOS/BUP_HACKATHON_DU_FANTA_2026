import type { Alert, Allocation, Fuel, Network, NetworkRoute, Recommendation, RiskLevel } from "@/lib/api/schemas";
import { sitePosition, type SitePosition } from "@/lib/map/sites";

export type SiteLevel = "normal" | "elevated" | "critical" | "empty" | "outage";

export interface MapFuel {
  fuel: Fuel;
  inventory: number;
  capacity: number;
  fill: number;
  risk?: RiskLevel;
  hours?: number | null;
}

export interface MapSite {
  id: string;
  kind: "station" | "depot";
  name: string;
  regionId: string;
  status: string;
  pos: SitePosition;
  level: SiteLevel;
  fuels: MapFuel[];
  alerts: Alert[]; // open alerts about this site
  pending: Recommendation[]; // waiting for review, stations only
  dispatchLeft?: number; // depots: litres that can still leave this tick
  spike?: number; // stations: demand multiplier while a demand spike is active
}

export interface MapRoute {
  route: NetworkRoute;
  from: SitePosition;
  to: SitePosition;
  state: "ok" | "disrupted" | "scheduled";
  inTransit: Allocation[];
}

const FUEL_ORDER: Record<string, number> = { DIESEL: 0, PETROL: 1, OCTANE: 2 };
const LEVEL_RANK: Record<SiteLevel, number> = { normal: 0, elevated: 1, critical: 2, empty: 3, outage: 4 };

const fuelsOf = <T>(fuels: Record<string, T>, map: (fuel: Fuel, value: T) => MapFuel): MapFuel[] =>
  Object.entries(fuels)
    .filter(([fuel]) => fuel in FUEL_ORDER)
    .sort(([a], [b]) => FUEL_ORDER[a] - FUEL_ORDER[b])
    .map(([fuel, value]) => map(fuel as Fuel, value));

function stationLevel(status: string, fuels: MapFuel[]): SiteLevel {
  if (status === "OUTAGE") return "outage";
  if (fuels.some((f) => f.inventory <= 0)) return "empty";
  if (fuels.some((f) => f.risk === "critical" || f.risk === "high")) return "critical";
  if (fuels.some((f) => f.risk === "elevated")) return "elevated";
  return "normal";
}

function depotLevel(fuels: MapFuel[]): SiteLevel {
  if (fuels.some((f) => f.inventory <= 0)) return "empty";
  if (fuels.some((f) => f.fill < 0.1)) return "critical";
  if (fuels.some((f) => f.fill < 0.25)) return "elevated";
  return "normal";
}

const subjectSite = (subject: string | null | undefined) => (subject ?? "").split(":")[0];

// Everything the map draws, from the same API data the tables use.
export function buildMapModel(network: Network, alerts: Alert[], pending: Recommendation[], allocations: Allocation[]) {
  const alertsBySite = new Map<string, Alert[]>();
  for (const alert of alerts) {
    const site = subjectSite(alert.subject);
    alertsBySite.set(site, [...(alertsBySite.get(site) ?? []), alert]);
  }

  const stations: MapSite[] = network.stations.map((s, i) => {
    const fuels = fuelsOf(s.fuels, (fuel, f) => ({
      fuel,
      inventory: f.inventory,
      capacity: f.capacity,
      fill: f.fill,
      risk: f.risk_level,
      hours: f.time_to_stockout_hours,
    }));
    return {
      id: s.id,
      kind: "station",
      name: s.name,
      regionId: s.region_id,
      status: s.status,
      pos: sitePosition(s.id, s.region_id, i),
      level: stationLevel(s.status, fuels),
      fuels,
      alerts: alertsBySite.get(s.id) ?? [],
      pending: pending.filter((r) => r.station_id === s.id),
      spike: s.demand_multiplier > 1.001 ? s.demand_multiplier : undefined,
    };
  });

  const depots: MapSite[] = network.depots.map((d, i) => {
    const fuels = fuelsOf(d.fuels, (fuel, f) => ({ fuel, inventory: f.inventory, capacity: f.capacity, fill: f.fill }));
    return {
      id: d.id,
      kind: "depot",
      name: d.name,
      regionId: d.region_id,
      status: d.status,
      pos: sitePosition(d.id, d.region_id, i + network.stations.length),
      level: depotLevel(fuels),
      fuels,
      alerts: alertsBySite.get(d.id) ?? [],
      pending: [],
      dispatchLeft: d.dispatch_left_this_tick,
    };
  });

  const where = new Map([...stations, ...depots].map((site) => [site.id, site.pos]));
  const routes: MapRoute[] = network.routes.flatMap((route) => {
    const from = where.get(route.source_depot_id);
    const to = where.get(route.destination_station_id);
    if (!from || !to) return [];
    const scheduled = route.disruptions.some((d) => d.status === "SCHEDULED");
    return [
      {
        route,
        from,
        to,
        state: !route.usable_now || route.status === "DISRUPTED" ? "disrupted" : scheduled ? "scheduled" : "ok",
        inTransit: allocations.filter((a) => a.route_id === route.id && (a.status === "IN_TRANSIT" || a.status === "PENDING")),
      },
    ];
  });

  const worst = (sites: MapSite[]) => sites.reduce<SiteLevel>((acc, s) => (LEVEL_RANK[s.level] > LEVEL_RANK[acc] ? s.level : acc), "normal");
  return { stations, depots, routes, worst: worst(stations) };
}

export type MapModel = ReturnType<typeof buildMapModel>;

// Cross-region routes bend (quadratic curve) so they do not lie on top of the direct ones.
export function routeCurve({ from, to, route }: MapRoute) {
  const bend = route.cross_region ? 0.18 : 0;
  const control = { x: (from.x + to.x) / 2 - (to.y - from.y) * bend, y: (from.y + to.y) / 2 + (to.x - from.x) * bend };
  return { from, control, to };
}

export function pointOnRoute(route: MapRoute, t: number): { x: number; y: number } {
  const { from, control, to } = routeCurve(route);
  const u = 1 - t;
  return { x: u * u * from.x + 2 * u * t * control.x + t * t * to.x, y: u * u * from.y + 2 * u * t * control.y + t * t * to.y };
}

// How far along its route a shipment is: 0 while PENDING at the depot, then departure -> arrival.
export function shipmentProgress(a: Allocation, tick: number): number {
  if (a.status === "PENDING" || a.departure_tick == null || a.expected_arrival_tick == null) return 0;
  const span = Math.max(a.expected_arrival_tick - a.departure_tick, 1);
  return Math.min(Math.max((tick - a.departure_tick) / span, 0), 1);
}
