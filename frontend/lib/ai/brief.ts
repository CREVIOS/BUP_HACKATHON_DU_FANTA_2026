import type { RecommendationSummary } from "@/lib/ai/backend";
import { lowStock, networkFacts, type StockEntry } from "@/lib/ai/facts";
import { HEALTHY_DATA, type DataQuality } from "@/lib/ai/quality";
import { formatNumber, humanize } from "@/lib/format";
import { groupBy } from "@/lib/group";
import type { Target } from "@/lib/targets";
import type { Snapshot } from "@/lib/types";

export const MAX_ITEMS = 8;
export const TITLE_MAX = 90;
export const DETAIL_MAX = 260;
const HEADLINE_MAX = 120;
const CRITICAL_PERCENT = 20;
const WATCH_PERCENT = 40;
const SERVICE_LEVEL_WARN = 0.98;
const REVIEW_SHOWN = 2;

export type Severity = "high" | "medium" | "low";
export type BriefStatus = "stable" | "watch" | "critical";

// A problem found by code: its words and figures are computed, never written by a model. `id` is stable
// across ticks (it names the problem, not its numbers) and `target` is where the operator acts on it.
export interface BriefItem {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  target: Target;
  note?: string; // written by the model: why it is happening and what to do next
}

// What changed since the previous briefing, computed by comparing item ids.
export interface BriefChanges {
  sinceTick: number;
  added: string[];
  resolved: string[];
  worse: string[];
}

export interface Brief {
  headline: string;
  status: BriefStatus;
  items: BriefItem[];
  summary?: string; // written by the model: what matters most now and why
  changes?: BriefChanges;
  source: "ai" | "rules"; // who wrote the summary and notes: the model, or nobody (rules only)
  tick: number; // the figures are from this tick
  notesTick?: number; // the model wrote the summary and notes at this tick
  notesPending?: boolean; // the model is writing new notes; ask again shortly
}

export type BriefResponse = Brief;

const MAX_STATION_ITEMS = 4;

function listWords(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

// One item per station, however many of its fuels are critical: "Mirpur: diesel, petrol and octane empty".
function stationTitle(name: string, entries: StockEntry[]): string {
  const fuels = entries.map((e) => humanize(e.fuel).toLowerCase());
  if (entries.every((e) => e.inventory <= 0)) return `${name}: ${listWords(fuels)} empty`;
  if (entries.length === 1) return `${name}: ${humanize(entries[0].fuel)} at ${entries[0].percent}%`;
  return `${name}: ${listWords(entries.map((e) => `${humanize(e.fuel).toLowerCase()} ${e.percent}%`))}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`);
const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export const bySeverity = <T extends { severity: Severity }>(items: T[]): T[] => [...items].sort((a, b) => RANK[a.severity] - RANK[b.severity]);

const waitingFor = (pending: readonly RecommendationSummary[]) => pending.filter((r) => r.status === "PROPOSED");

// A station's problem opens the proposal waiting for it, if there is one; otherwise the stations table.
function stationTarget(entries: StockEntry[], pending: readonly RecommendationSummary[]): Target {
  const proposal = entries.map((e) => pending.find((r) => r.station_id === e.id && r.fuel_type === e.fuel)).find(Boolean);
  return proposal ? { tab: "decisions", seriesKey: `${proposal.station_id}:${proposal.fuel_type}` } : { tab: "network", section: "stations" };
}

// Everything worth an operator's attention, computed from the snapshot (and the proposals waiting for
// review) without any model.
export function findings(snapshot: Snapshot, quality: DataQuality = HEALTHY_DATA, pending: readonly RecommendationSummary[] = []): BriefItem[] {
  const facts = networkFacts(snapshot, quality);
  const names = new Map([...snapshot.depots, ...snapshot.stations].map((e) => [e.id, e.name]));
  const waiting = waitingFor(pending);
  const out: BriefItem[] = [];
  const add = (id: string, severity: Severity, title: string, detail: string, target: Target) =>
    out.push({ id, severity, title: clip(title, TITLE_MAX), detail: clip(detail, DETAIL_MAX), target });

  if (!quality.sourceHealthy) {
    add("data", "high", "Data may be out of date", quality.reason ?? "The data source is not confirmed healthy.", { tab: "overview", section: "system" });
  } else if (quality.stale) {
    add("stale", "medium", "Simulator data is stale", "The simulator flagged its responses as stale.", { tab: "overview", section: "system" });
  }

  const critical = lowStock(snapshot, CRITICAL_PERCENT).filter((x) => x.kind === "station");
  for (const { key, items } of groupBy(critical, (e) => e.id).slice(0, MAX_STATION_ITEMS)) {
    const detail = items.map((e) => `${humanize(e.fuel)} ${formatNumber(e.inventory)} of ${formatNumber(e.capacity)} L`).join("; ");
    add(`stock:${key}`, "high", stationTitle(items[0].name, items), `${detail}.`, stationTarget(items, waiting));
  }
  if (facts.outageStations.length > 0) {
    add("outage", "high", `${plural(facts.outageStations.length, "station")} in outage`, facts.outageStations.join(", "), { tab: "network", section: "stations" });
  }
  if (facts.disruptedRoutes.length > 0) {
    add("routes", "high", `${plural(facts.disruptedRoutes.length, "route")} disrupted`, facts.disruptedRoutes.map((r) => `${r.from} to ${r.to}`).join("; "), { tab: "network", section: "routes" });
  }
  const failed = facts.allocationsByStatus["FAILED"] ?? 0;
  if (failed > 0) {
    add("failed", "high", `${plural(failed, "allocation")} failed`, "Fuel was committed but did not arrive.", { tab: "network", section: "activity" });
  }

  if (waiting.length > 0) {
    const riskiest = [...waiting].sort((a, b) => (b.risk_before ?? 0) - (a.risk_before ?? 0)).slice(0, REVIEW_SHOWN);
    const detail = riskiest.map((r) => `${names.get(r.station_id) ?? r.station_id} ${humanize(r.fuel_type).toLowerCase()}, ${formatNumber(Math.floor(r.quantity))} L`).join("; ");
    add("review", "medium", `${plural(waiting.length, "proposal")} waiting for review`, detail, { tab: "decisions" });
  }
  const watch = lowStock(snapshot, WATCH_PERCENT).filter((e) => e.percent > CRITICAL_PERCENT || e.kind === "depot");
  if (watch.length > 0) {
    const onlyDepots = watch.every((e) => e.kind === "depot");
    add("watch", "medium", `${plural(watch.length, "fuel level")} below ${WATCH_PERCENT}%`, watch.slice(0, 3).map((e) => `${e.name} ${humanize(e.fuel).toLowerCase()} ${e.percent}%`).join("; "), { tab: "network", section: onlyDepots ? "depots" : "stations" });
  }
  if (facts.activeEvents.length > 0) {
    add("events", "medium", `Active: ${facts.activeEvents.map((e) => humanize(e.type)).join(", ")}`, facts.activeEvents.map((e) => `${humanize(e.type)} until tick ${e.endTick}`).join("; "), { tab: "network", section: "activity" });
  }
  if (facts.delayedSupply.length > 0) {
    const first = facts.delayedSupply[0];
    add("supply", "medium", `${plural(facts.delayedSupply.length, "supply delivery")} delayed`, `${first.depot} ${humanize(first.fuel).toLowerCase()}, ${formatNumber(first.quantity)} L, planned for tick ${first.plannedTick}.`, { tab: "network", section: "activity" });
  }
  if (facts.serviceLevel === undefined) {
    add("metrics", "low", "Service metrics unavailable", "The simulator has not reported service level yet.", { tab: "overview", section: "system" });
  } else if (facts.serviceLevel < SERVICE_LEVEL_WARN) {
    add("service", "medium", `Service level at ${(facts.serviceLevel * 100).toFixed(1)}%`, `${formatNumber(facts.unmetLiters)} L of demand went unmet.`, { tab: "overview", section: "risk" });
  }
  return out;
}

// The briefing as code sees it: status, headline and every problem with its figures and link. The model
// only adds a summary and notes on top (generate-brief), so it can never hide or soften a problem.
export function buildTemplateBrief(snapshot: Snapshot, quality: DataQuality = HEALTHY_DATA, pending: readonly RecommendationSummary[] = []): Brief {
  const tick = snapshot.instance.tick;
  const items = bySeverity(findings(snapshot, quality, pending)).slice(0, MAX_ITEMS);
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
