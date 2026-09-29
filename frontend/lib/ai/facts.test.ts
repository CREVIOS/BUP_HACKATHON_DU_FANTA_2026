import { describe, expect, it } from "vitest";
import { lowStock, networkFacts, stockEntries } from "@/lib/ai/facts";
import { BASELINE } from "@/lib/mock/baseline";
import { mockSnapshot } from "@/lib/mock/scenarios";

describe("stockEntries", () => {
  it("covers every depot and station by fuel", () => {
    expect(stockEntries(BASELINE)).toHaveLength((2 + 4) * 3);
  });

  it("computes whole-number percentages and levels", () => {
    const mirpurDiesel = stockEntries(mockSnapshot("crisis")).find(
      (e) => e.id === "station-mirpur" && e.fuel === "DIESEL",
    );
    expect(mirpurDiesel).toMatchObject({ inventory: 2100, capacity: 15000, percent: 14, level: "low" });
  });

  it("skips fuels with no capacity instead of dividing by zero", () => {
    const snapshot = { ...BASELINE, stations: [{ ...BASELINE.stations[0], capacity: {}, inventory: {} }], depots: [] };
    expect(stockEntries(snapshot)).toEqual([]);
  });
});

describe("lowStock", () => {
  it("is empty on the healthy baseline", () => {
    expect(lowStock(BASELINE)).toEqual([]);
  });

  it("returns entries at or below the threshold, emptiest first", () => {
    const entries = lowStock(mockSnapshot("crisis"), 40);
    expect(entries.length).toBeGreaterThan(1);
    expect(entries[0]).toMatchObject({ id: "station-mirpur", fuel: "DIESEL", percent: 14 });
    const percents = entries.map((e) => e.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(entries.every((e) => e.percent <= 40)).toBe(true);
  });
});

describe("networkFacts", () => {
  it("reports a quiet network", () => {
    const facts = networkFacts(BASELINE);
    expect(facts).toMatchObject({ tick: 0, disruptedRoutes: [], outageStations: [], activeEvents: [], delayedSupply: [] });
  });

  it("resolves names for disrupted routes and delayed supply in a crisis", () => {
    const facts = networkFacts(mockSnapshot("crisis"));
    expect(facts.disruptedRoutes).toEqual([
      { id: "route-gazipur-mirpur", from: "Gazipur Depot", to: "Mirpur Fuel Station" },
    ]);
    expect(facts.activeEvents.map((e) => e.type).sort()).toEqual(["demand_spike", "route_disruption"]);
    expect(facts.delayedSupply).toHaveLength(1);
    expect(facts.allocationsByStatus).toEqual({ ARRIVED: 1, IN_TRANSIT: 2, FAILED: 1, PENDING: 1 });
    expect(facts.serviceLevel).toBeCloseTo(0.943);
  });

  it("does not mutate its input", () => {
    const snapshot = mockSnapshot("crisis");
    const before = structuredClone(snapshot);
    networkFacts(snapshot);
    lowStock(snapshot);
    expect(snapshot).toEqual(before);
  });
});
