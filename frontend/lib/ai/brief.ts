import { z } from "zod";
import { lowStock, networkFacts } from "@/lib/ai/facts";
import { HEALTHY_DATA, type DataQuality } from "@/lib/ai/quality";
import { formatNumber, humanize } from "@/lib/format";
import type { Snapshot } from "@/lib/types";

export const MAX_ITEMS = 8;
const TITLE_MAX = 90;
const DETAIL_MAX = 260;
const HEADLINE_MAX = 120;
const CRITICAL_PERCENT = 20;
const WATCH_PERCENT = 40;
const SERVICE_LEVEL_WARN = 0.98;

export const briefSchema = z.object({
  headline: z.string().min(1).max(HEADLINE_MAX),
  status: z.enum(["stable", "watch", "critical"]),
  items: z
    .array(
      z.object({
        severity: z.enum(["high", "medium", "low"]),
        title: z.string().min(1).max(TITLE_MAX),
        detail: z.string().max(DETAIL_MAX),
      }),
    )
    .max(MAX_ITEMS),
});

export type BriefContent = z.infer<typeof briefSchema>;
export type BriefItem = BriefContent["items"][number];
export type BriefStatus = BriefContent["status"];

export interface Brief extends BriefContent {
  source: "ai" | "rules"; // who wrote the words: the model, or the deterministic template
  tick: number;
}

export type BriefResponse = Brief & { mock: boolean }; // mock: the answer came from the mock model

// A problem found by code. `subjects` are lowercase phrases a model's write-up must mention;
// if none appears, the model left this problem out and it gets added back (see generate-brief).
export interface Finding extends BriefItem {
  subjects: string[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`);
const RANK = { high: 0, medium: 1, low: 2 } as const;
const STATUS_RANK: Record<BriefStatus, number> = { stable: 0, watch: 1, critical: 2 };

// Drop the internal `subjects` before a finding is shown to anyone.
export const toItem = ({ severity, title, detail }: Finding): BriefItem => ({ severity, title, detail });

export const worseStatus = (a: BriefStatus, b: BriefStatus): BriefStatus =>
  STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;

export const bySeverity = <T extends { severity: BriefItem["severity"] }>(items: T[]): T[] =>
  [...items].sort((a, b) => RANK[a.severity] - RANK[b.severity]);

// Everything worth an operator's attention, computed from the snapshot without any model.
export function findings(snapshot: Snapshot, quality: DataQuality = HEALTHY_DATA): Finding[] {
  const facts = networkFacts(snapshot, quality);
  const out: Finding[] = [];
  const add = (severity: BriefItem["severity"], title: string, detail: string, subjects: string[]) =>
    out.push({ severity, title: clip(title, TITLE_MAX), detail: clip(detail, DETAIL_MAX), subjects: subjects.map((s) => s.toLowerCase()) });

  if (!quality.sourceHealthy) {
    add("high", "Data may be out of date", quality.reason ?? "The data source is not confirmed healthy.", ["out of date", "outdated", "stale", "not confirm", "unhealthy"]);
  } else if (quality.stale) {
    add("medium", "Simulator data is stale", "The simulator flagged its responses as stale.", ["stale"]);
  }

  for (const e of lowStock(snapshot, CRITICAL_PERCENT).filter((x) => x.kind === "station").slice(0, 3)) {
    add("high", `${e.name}: ${humanize(e.fuel)} at ${e.percent}%`, `${formatNumber(e.inventory)} L of ${formatNumber(e.capacity)} L in stock.`, [e.name]);
  }
  if (facts.outageStations.length > 0) {
    add("high", `${plural(facts.outageStations.length, "station")} in outage`, facts.outageStations.join(", "), [...facts.outageStations, "outage"]);
  }
  if (facts.disruptedRoutes.length > 0) {
    add("high", `${plural(facts.disruptedRoutes.length, "route")} disrupted`, facts.disruptedRoutes.map((r) => `${r.from} to ${r.to}`).join("; "), ["disrupt"]);
  }
  const failed = facts.allocationsByStatus["FAILED"] ?? 0;
  if (failed > 0) {
    add("high", `${plural(failed, "allocation")} failed`, "Fuel was committed but did not arrive. Review the allocations list.", ["failed", "failure"]);
  }

  const watch = lowStock(snapshot, WATCH_PERCENT).filter((e) => e.percent > CRITICAL_PERCENT || e.kind === "depot");
  if (watch.length > 0) {
    add("medium", `${plural(watch.length, "fuel level")} below ${WATCH_PERCENT}%`, watch.slice(0, 3).map((e) => `${e.name} ${humanize(e.fuel).toLowerCase()} ${e.percent}%`).join("; "), []);
  }
  if (facts.activeEvents.length > 0) {
    add("medium", `Active: ${facts.activeEvents.map((e) => humanize(e.type)).join(", ")}`, facts.activeEvents.map((e) => `${humanize(e.type)} until tick ${e.endTick}`).join("; "), []);
  }
  if (facts.delayedSupply.length > 0) {
    const first = facts.delayedSupply[0];
    add("medium", `${plural(facts.delayedSupply.length, "supply delivery")} delayed`, `${first.depot} ${humanize(first.fuel).toLowerCase()}, ${formatNumber(first.quantity)} L, planned for tick ${first.plannedTick}.`, []);
  }
  if (facts.serviceLevel === undefined) {
    add("low", "Service metrics unavailable", "The simulator has not reported service level yet.", []);
  } else if (facts.serviceLevel < SERVICE_LEVEL_WARN) {
    add("medium", `Service level at ${(facts.serviceLevel * 100).toFixed(1)}%`, `${formatNumber(facts.unmetLiters)} L of demand went unmet.`, ["service level"]);
  }
  return out;
}

// Deterministic brief from the same facts the assistant may quote. It is the fallback when the
// model is unavailable, and the floor a model's brief may never fall below.
export function buildTemplateBrief(snapshot: Snapshot, quality: DataQuality = HEALTHY_DATA): Brief {
  const tick = snapshot.instance.tick;
  const items: BriefItem[] = bySeverity(findings(snapshot, quality)).slice(0, MAX_ITEMS).map(toItem);
  const highCount = items.filter((i) => i.severity === "high").length;
  const status: BriefStatus = highCount > 0 ? "critical" : items.some((i) => i.severity === "medium") ? "watch" : "stable";
  const headline =
    status === "critical"
      ? `${plural(highCount, "critical issue")} at tick ${tick}`
      : status === "watch"
        ? `${plural(items.length, "item")} to watch at tick ${tick}`
        : `Network stable at tick ${tick}`;
  return { headline: clip(headline, HEADLINE_MAX), status, items, source: "rules", tick };
}
