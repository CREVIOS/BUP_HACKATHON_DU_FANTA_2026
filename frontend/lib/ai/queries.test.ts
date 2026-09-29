import { describe, expect, it } from "vitest";
import { allocationSummaries, eventSummaries, routeSummaries, stockFor } from "@/lib/ai/queries";
import { BASELINE } from "@/lib/mock/baseline";
import { mockSnapshot } from "@/lib/mock/scenarios";

const crisis = mockSnapshot("crisis");

describe("routeSummaries", () => {
  it("resolves names and converts ticks to minutes", () => {
    const route = routeSummaries(BASELINE).find((r) => r.id === "route-gazipur-mirpur");
    expect(route).toEqual({
      id: "route-gazipur-mirpur",
      from: "Gazipur Depot",
      to: "Mirpur Fuel Station",
      status: "AVAILABLE",
      transitMinutes: 30,
      maxShipment: 7000,
    });
  });

  it("filters by status", () => {
    expect(routeSummaries(crisis, "DISRUPTED").map((r) => r.id)).toEqual(["route-gazipur-mirpur"]);
    expect(routeSummaries(crisis, "AVAILABLE")).toHaveLength(5);
  });
});

describe("eventSummaries", () => {
  it("is empty without events and lists them in a crisis", () => {
    expect(eventSummaries(BASELINE)).toEqual([]);
    expect(eventSummaries(crisis).map((e) => e.type)).toEqual(["route_disruption", "demand_spike"]);
  });
});

describe("allocationSummaries", () => {
  it("returns newest first and honours the limit", () => {
    const list = allocationSummaries(crisis, undefined, 3);
    expect(list.map((a) => a.id)).toEqual([44, 43, 42]);
  });

  it("filters by status and resolves names", () => {
    const [failed] = allocationSummaries(crisis, "FAILED");
    expect(failed).toMatchObject({ id: 43, from: "Gazipur Depot", to: "Mirpur Fuel Station", fuel: "PETROL" });
  });
});

describe("stockFor", () => {
  it("returns every fuel for one entity", () => {
    expect(stockFor(crisis, "station-mirpur").map((e) => e.fuel).sort()).toEqual(["DIESEL", "OCTANE", "PETROL"]);
  });

  it("returns nothing for an unknown id", () => {
    expect(stockFor(crisis, "station-nowhere")).toEqual([]);
  });
});
