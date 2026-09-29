import { describe, expect, it } from "vitest";
import { briefSchema, buildTemplateBrief, findings, MAX_ITEMS } from "@/lib/ai/brief";
import { HEALTHY_DATA } from "@/lib/ai/quality";
import { BASELINE } from "@/lib/mock/baseline";
import { crisisSnapshot } from "@/lib/mock/scenarios";

describe("buildTemplateBrief", () => {
  it("says the network is stable when nothing is wrong", () => {
    const brief = buildTemplateBrief(BASELINE);
    expect(brief).toMatchObject({ status: "stable", source: "rules", tick: 0, items: [] });
    expect(brief.headline).toContain("stable");
  });

  it("goes critical in a crisis and names the worst station first", () => {
    const brief = buildTemplateBrief(crisisSnapshot());
    expect(brief.status).toBe("critical");
    expect(brief.items[0]).toMatchObject({ severity: "high" });
    expect(brief.items[0].title).toContain("Mirpur Fuel Station");
    expect(brief.items[0].title).toContain("14%");
  });

  it("calls out the disrupted route, failed allocation and delayed supply", () => {
    const text = JSON.stringify(buildTemplateBrief(crisisSnapshot()).items);
    expect(text).toContain("Gazipur Depot to Mirpur Fuel Station");
    expect(text).toMatch(/failed/i);
    expect(text).toMatch(/delayed/i);
  });

  it("keeps items high severity first and within the schema limits", () => {
    const brief = buildTemplateBrief(crisisSnapshot());
    expect(brief.items.length).toBeLessThanOrEqual(MAX_ITEMS);
    const rank = { high: 0, medium: 1, low: 2 } as const;
    const ranks = brief.items.map((i) => rank[i.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(briefSchema.safeParse({ headline: brief.headline, status: brief.status, items: brief.items }).success).toBe(true);
  });

  it("does not mutate its input", () => {
    const snapshot = crisisSnapshot();
    const before = structuredClone(snapshot);
    buildTemplateBrief(snapshot);
    expect(snapshot).toEqual(before);
  });

  it("never claims stable when the data source is unhealthy", () => {
    const brief = buildTemplateBrief(BASELINE, { stale: false, sourceHealthy: false, reason: "fuel simulator: no successful simulator poll for 42s" });
    expect(brief.status).toBe("critical");
    expect(brief.items[0].severity).toBe("high");
    expect(brief.items[0].title).toMatch(/out of date/i);
    expect(brief.items[0].detail).toContain("42s");
  });

  it("flags a stale simulator feed as something to watch", () => {
    const brief = buildTemplateBrief(BASELINE, { stale: true, sourceHealthy: true });
    expect(brief.status).toBe("watch");
    expect(brief.items.map((i) => i.title).join(" ")).toMatch(/stale/i);
  });

  it("reports a degraded service level", () => {
    const text = JSON.stringify(buildTemplateBrief(crisisSnapshot()).items);
    expect(text).toContain("94.3%");
    expect(text).toContain("18,450");
  });

  it("says when service metrics are missing instead of implying all is well", () => {
    const brief = buildTemplateBrief({ ...BASELINE, metrics: undefined });
    expect(brief.items.map((i) => i.title).join(" ")).toMatch(/metrics unavailable/i);
  });

  it("clips long text so a large dataset cannot break the schema", () => {
    const long = "Very ".repeat(60) + "Long Station";
    const crisis = crisisSnapshot();
    const snapshot = { ...crisis, stations: crisis.stations.map((s) => ({ ...s, name: long })) };
    const brief = buildTemplateBrief(snapshot);
    expect(briefSchema.safeParse({ headline: brief.headline, status: brief.status, items: brief.items }).success).toBe(true);
  });

  it("caps the number of items", () => {
    expect(buildTemplateBrief(crisisSnapshot()).items.length).toBeLessThanOrEqual(MAX_ITEMS);
  });
});

describe("findings", () => {
  it("attaches lowercase subjects used to check a model did not omit a problem", () => {
    const list = findings(crisisSnapshot(), HEALTHY_DATA);
    const high = list.filter((f) => f.severity === "high");
    expect(high.length).toBeGreaterThanOrEqual(3);
    expect(high.every((f) => f.subjects.length > 0 && f.subjects.every((x) => x === x.toLowerCase()))).toBe(true);
    expect(high[0].subjects).toContain("mirpur fuel station");
  });

  it("groups a station's critical fuels into one item instead of repeating the station", () => {
    const crisis = crisisSnapshot();
    const empty = { DIESEL: 0, PETROL: 0, OCTANE: 0 };
    const snapshot = { ...crisis, stations: crisis.stations.map((s) => ({ ...s, inventory: empty })) };
    const brief = buildTemplateBrief(snapshot);
    const stationItems = brief.items.filter((i) => / empty$/.test(i.title));
    expect(stationItems).toHaveLength(snapshot.stations.length);
    expect(stationItems[0].title).toMatch(/^.+: diesel, petrol and octane empty$/);
    expect(new Set(stationItems.map((i) => i.title.split(":")[0])).size).toBe(snapshot.stations.length);
  });
});
