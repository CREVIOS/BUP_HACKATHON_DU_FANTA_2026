import { describe, expect, it } from "vitest";
import type { RecommendationSummary } from "@/lib/ai/backend";
import { buildTemplateBrief, DETAIL_MAX, findings, MAX_ITEMS, TITLE_MAX, type Brief } from "@/lib/ai/brief";
import { createBriefHistory } from "@/lib/ai/brief-changes";
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
    expect(brief.items.every((i) => i.title.length <= TITLE_MAX && i.detail.length <= DETAIL_MAX)).toBe(true);
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

  it("clips long text so a large dataset cannot overflow the panel", () => {
    const long = "Very ".repeat(60) + "Long Station";
    const crisis = crisisSnapshot();
    const snapshot = { ...crisis, stations: crisis.stations.map((s) => ({ ...s, name: long })) };
    const brief = buildTemplateBrief(snapshot);
    expect(brief.items.every((i) => i.title.length <= TITLE_MAX && i.detail.length <= DETAIL_MAX)).toBe(true);
  });

  it("caps the number of items", () => {
    expect(buildTemplateBrief(crisisSnapshot()).items.length).toBeLessThanOrEqual(MAX_ITEMS);
  });
});

describe("findings", () => {
  it("gives each problem a stable id and a page to act on", () => {
    const list = findings(crisisSnapshot(), HEALTHY_DATA);
    expect(new Set(list.map((f) => f.id)).size).toBe(list.length);
    expect(list.find((f) => f.id === "stock:station-mirpur")?.target).toEqual({ tab: "network", section: "stations" });
    expect(list.find((f) => f.id === "routes")?.target).toEqual({ tab: "network", section: "routes" });
  });

  it("links a station to its waiting proposal and lists the proposals to review", () => {
    const proposal: RecommendationSummary = { id: 7, station_id: "station-mirpur", fuel_type: "DIESEL", quantity: 5000.9, verdict: "review", status: "PROPOSED", risk_before: 1, risk_after: 0.2 };
    const list = findings(crisisSnapshot(), HEALTHY_DATA, [proposal]);
    expect(list.find((f) => f.id === "stock:station-mirpur")?.target).toEqual({ tab: "decisions", seriesKey: "station-mirpur:DIESEL" });
    expect(list.find((f) => f.id === "review")).toMatchObject({ title: "1 proposal waiting for review", detail: "Mirpur Fuel Station diesel, 5,000 L", target: { tab: "decisions" } });
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

describe("createBriefHistory", () => {
  const item = (id: string, severity: "high" | "medium" = "high") => ({ id, severity, title: `${id} title`, detail: "", target: { tab: "network" as const } });
  const brief = (tick: number, items: ReturnType<typeof item>[]): Brief => ({ headline: "", status: "critical", items, source: "rules", tick });

  it("reports what appeared, cleared and got worse, and keeps it while nothing material changes", () => {
    const history = createBriefHistory();
    expect(history.track("s", brief(1, [item("a"), item("b", "medium")]))).toBeUndefined();
    const changes = history.track("s", brief(5, [item("b"), item("c")]));
    expect(changes).toEqual({ sinceTick: 1, added: ["c title"], resolved: ["a title"], worse: ["b title"] });
    expect(history.track("s", brief(9, [item("b"), item("c")]))).toEqual(changes);
  });
});
