import { describe, expect, it } from "vitest";
import recommendations from "@/lib/api/__fixtures__/recommendations.json";
import { recommendationsSchema, type Recommendation } from "@/lib/api/schemas";
import { seriesKey, sortQueue } from "@/lib/queue";

const recs = recommendationsSchema.parse(recommendations).recommendations;
const rec = (over: Partial<Recommendation>): Recommendation => ({ ...recs[0], ...over });

describe("seriesKey", () => {
  it("identifies a recommendation by station and fuel, which survives a new proposal each tick", () => {
    expect(seriesKey(rec({ id: 1, station_id: "station-mirpur", fuel_type: "PETROL" }))).toBe(
      seriesKey(rec({ id: 99, station_id: "station-mirpur", fuel_type: "PETROL" })),
    );
  });
});

describe("sortQueue", () => {
  const names = new Map([
    ["station-a", "Alpha"],
    ["station-b", "Bravo"],
  ]);

  it("orders by risk first, then station name, then fuel, so the order is stable across ticks", () => {
    const queue = [
      rec({ id: 5, station_id: "station-b", fuel_type: "DIESEL", risk_before: 1 }),
      rec({ id: 6, station_id: "station-a", fuel_type: "PETROL", risk_before: 1 }),
      rec({ id: 7, station_id: "station-a", fuel_type: "DIESEL", risk_before: 1 }),
      rec({ id: 8, station_id: "station-a", fuel_type: "OCTANE", risk_before: 0.4 }),
    ];
    expect(sortQueue(queue, names).map((r) => r.id)).toEqual([7, 6, 5, 8]);
  });

  it("keeps only the newest proposal per station and fuel", () => {
    const queue = [
      rec({ id: 10, station_id: "station-a", fuel_type: "DIESEL" }),
      rec({ id: 12, station_id: "station-a", fuel_type: "DIESEL" }),
    ];
    expect(sortQueue(queue, names).map((r) => r.id)).toEqual([12]);
  });

  it("does not mutate its input", () => {
    const queue = [rec({ id: 2, station_id: "station-b" }), rec({ id: 1, station_id: "station-a" })];
    const before = queue.map((r) => r.id);
    sortQueue(queue, names);
    expect(queue.map((r) => r.id)).toEqual(before);
  });
});
