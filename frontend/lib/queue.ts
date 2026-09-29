import type { Recommendation } from "@/lib/api/schemas";

const FUEL_ORDER = { DIESEL: 0, PETROL: 1, OCTANE: 2 } as const;

// While the simulator runs, each tick replaces a PROPOSED recommendation with a newer one for the
// same station and fuel. The UI tracks that pair, not the id, so a selection survives the refresh.
export const seriesKey = (rec: Pick<Recommendation, "station_id" | "fuel_type">): string => `${rec.station_id}:${rec.fuel_type}`;

// Newest proposal per series, most at risk first, then by station name and fuel: an order that does
// not reshuffle every tick.
export function sortQueue(recs: readonly Recommendation[], names: ReadonlyMap<string, string>): Recommendation[] {
  const newest = new Map<string, Recommendation>();
  for (const rec of recs) {
    const key = seriesKey(rec);
    const seen = newest.get(key);
    if (!seen || rec.id > seen.id) newest.set(key, rec);
  }
  const name = (r: Recommendation) => names.get(r.station_id) ?? r.station_id;
  return [...newest.values()].sort(
    (a, b) =>
      (b.risk_before ?? 0) - (a.risk_before ?? 0) ||
      name(a).localeCompare(name(b)) ||
      FUEL_ORDER[a.fuel_type] - FUEL_ORDER[b.fuel_type],
  );
}
