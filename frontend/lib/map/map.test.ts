import { describe, expect, it } from "vitest";
import { MAP_HEIGHT, MAP_WIDTH } from "@/lib/map/bangladesh";
import { sitePosition } from "@/lib/map/sites";
import { alertTarget } from "@/lib/targets";

const inside = (p: { x: number; y: number }) => p.x > 0 && p.x < MAP_WIDTH && p.y > 0 && p.y < MAP_HEIGHT;

describe("map", () => {
  it("places known and unknown sites inside Bangladesh, Dhaka north-west of Cox's Bazar", () => {
    const mirpur = sitePosition("station-mirpur", "region-dhaka", 0);
    const coxs = sitePosition("station-coxsbazar", "region-chattogram", 0);
    const unknown = sitePosition("station-new", "region-somewhere", 3);
    expect([mirpur, coxs, unknown].every(inside)).toBe(true);
    expect(mirpur.x).toBeLessThan(coxs.x);
    expect(mirpur.y).toBeLessThan(coxs.y);
  });

  it("sends each alert to the page where it can be acted on", () => {
    expect(alertTarget({ kind: "stockout_risk", subject: "station-tongi:DIESEL" })).toEqual({ tab: "decisions", seriesKey: "station-tongi:DIESEL" });
    expect(alertTarget({ kind: "disruption", subject: "event-2" })).toEqual({ tab: "network", section: "routes" });
    expect(alertTarget({ kind: "stale_data", subject: "simulator" })).toEqual({ tab: "overview", section: "system" });
  });
});
