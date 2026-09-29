import type { RecommendationSummary } from "@/lib/ai/backend";
import type { Brief } from "@/lib/ai/brief";
import { lowStock, networkFacts } from "@/lib/ai/facts";
import { HEALTHY_DATA, type DataQuality } from "@/lib/ai/quality";
import type { Snapshot } from "@/lib/types";

export const CHAT_INSTRUCTIONS = `You are the operations assistant inside FuelOps, a console for a simulated fuel supply network in Bangladesh (Diesel, Petrol, Octane).

Rules:
- Call a tool before you state any number, name or status. Never guess or invent values.
- If the tools cannot answer, say what is missing.
- You are read-only. You cannot dispatch, approve or change anything. Recommendations are for a human operator to decide.
- To explain a recommendation, call listRecommendations to find its id, then explainRecommendation(id). Present it as: the headline on the first line in **bold**, then the narrative, then the factors as "- " bullet points, then a final line with confidence and action. Its headline, risk figures, confidence and action are computed and verified by the backend — quote them exactly, do not recompute them.
- Be brief: short sentences, plain language, litres with units. Use the station and depot names exactly as returned.
- Format for reading: short paragraphs separated by a blank line, "- " for lists, and **bold** for the single most important figure or label. Do not use headings or tables.
- If a tool fails, or getOverview shows dataQuality.stale or dataQuality.sourceHealthy is false, say the data may be out of date instead of guessing.`;

export const BRIEF_INSTRUCTIONS = `You add the "why" and the "what next" to an operator briefing for a simulated fuel supply network in Bangladesh.
The problems and their figures are already computed and shown to the operator: do not repeat or recompute them.
Use only names and numbers that appear in the input. A note or summary with any other number is discarded.
You cannot dispatch, approve or change anything. Suggest what the human operator should check or decide in FuelOps: Decisions to approve or reject waiting proposals, Network for stations, routes, depots and incoming supply.`;

const RISK_HORIZON_HOURS = 12;
const MAX_PROPOSALS = 8;

export interface BriefPromptInput {
  snapshot: Snapshot;
  quality?: DataQuality;
  brief: Pick<Brief, "items" | "changes">;
  pending?: readonly RecommendationSummary[];
}

const percent = (p: number | null) => (p == null ? null : Math.round(p * 100));

export function buildBriefPrompt({ snapshot, quality = HEALTHY_DATA, brief, pending = [] }: BriefPromptInput): string {
  const names = new Map([...snapshot.depots, ...snapshot.stations].map((e) => [e.id, e.name]));
  const problems = brief.items.map(({ id, severity, title, detail }) => ({ id, severity, title, detail }));
  const waiting = pending
    .filter((r) => r.status === "PROPOSED")
    .slice(0, MAX_PROPOSALS)
    .map((r) => ({
      station: names.get(r.station_id) ?? r.station_id,
      fuel: r.fuel_type,
      liters: Math.floor(r.quantity),
      stockoutRiskPercentWithout: percent(r.risk_before),
      stockoutRiskPercentWith: percent(r.risk_after),
    }));
  const changed = brief.changes && brief.changes.added.length + brief.changes.resolved.length + brief.changes.worse.length > 0 ? brief.changes : undefined;
  const facts = { horizonHours: RISK_HORIZON_HOURS, network: networkFacts(snapshot, quality), lowStock: lowStock(snapshot, 40).slice(0, 8) };
  return `For each problem, write one note of at most 200 characters, keyed by its id: the likely cause, from the facts, then the operator's next step. Skip a problem the facts do not explain.
Then write a summary of at most two sentences: what matters most right now and why.${changed ? " Say briefly what changed since the last briefing." : ""}

Problems (JSON):
${JSON.stringify(problems)}

Proposals waiting for review (JSON):
${JSON.stringify(waiting)}
${changed ? `\nChanged since tick ${changed.sinceTick} (JSON):\n${JSON.stringify(changed)}\n` : ""}
Facts (JSON):
${JSON.stringify(facts)}`;
}
