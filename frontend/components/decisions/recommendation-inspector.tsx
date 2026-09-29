"use client";

import { DecisionForm } from "@/components/decisions/decision-form";
import { QueryBlock } from "@/components/query-block";
import { EmptyState } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { useRecommendation } from "@/lib/api/hooks";
import type { Recommendation, RecommendationDetail } from "@/lib/api/schemas";
import { formatNumber, formatProbability, humanize } from "@/lib/format";
import { statusTone, type Tone } from "@/lib/tone";
import { cn } from "@/lib/utils";

const TICK_MINUTES = 15;
const STATUS_TONE: Partial<Record<string, Tone>> = { PROPOSED: "warn", SUBMITTED: "ok", APPROVED: "ok", REJECTED: "neutral", EXPIRED: "neutral" };
const FACT_TONE: Record<Tone, string> = { ok: "text-ok-fg", warn: "text-warn-fg", bad: "text-bad-fg", info: "text-info-fg", neutral: "" };

function Fact({ label, value, note, tone = "neutral" }: { label: string; value: string; note?: string; tone?: Tone }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 text-lg font-medium tabular-nums", FACT_TONE[tone])}>{value}</dd>
      {note ? <dd className="text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

type RL = NonNullable<Recommendation["explanation"]["rl"]>;

// The trained RL policy's choice in one line: its plan, how sure it is, and whether the rule baseline agrees.
function rlSummary(rl: RL): string {
  const baseline = rl.agrees_with_baseline
    ? "the rule baseline agrees"
    : rl.baseline_strategy === "wait"
      ? "the rule baseline would wait"
      : `the rule baseline would choose ${rl.baseline_strategy}`;
  return `RL policy chose ${rl.strategy} (${Math.round(rl.confidence * 100)}% sure); ${baseline}.`;
}

// The plans the RL policy weighed (brief section 9), with its probability for each.
function RLOptions({ rl }: { rl: RL }) {
  return (
    <div>
      <p className="mb-1 text-xs text-muted-foreground">
        RL plans weighed. This shipment is 1 of {rl.plan_shipments} in the chosen plan ({formatNumber(Math.round(rl.plan_liters))} L).
      </p>
      <ul className="space-y-1.5">
        {rl.options.slice(0, 4).map((o) => (
          <li key={o.action} className="text-xs">
            <div className="flex justify-between gap-2">
              <span className={o.action === rl.action ? "font-medium" : "text-muted-foreground"}>{o.strategy}</span>
              <span className="font-mono tabular-nums text-muted-foreground">{Math.round(o.probability * 100)}%</span>
            </div>
            <div className="mt-0.5 h-1.5 rounded-full bg-muted" aria-hidden>
              <div className={cn("h-full rounded-full", o.action === rl.action ? "bg-foreground" : "bg-chart-2")} style={{ width: `${Math.max(o.probability * 100, 1)}%` }} />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-1 font-mono text-[0.6875rem] text-muted-foreground">{rl.model}</p>
    </div>
  );
}

function sourceLabel(rec: Recommendation): string {
  if (rec.source === "fallback") return "fallback policy";
  if (rec.source === "manual") return "operator";
  return rec.policy_version;
}

interface Shared {
  names: ReadonlyMap<string, string>;
  formKey?: string;
  onDecided: (id: number) => void;
}

// The decision first: what, how much it helps, why a human is asked, then the controls. Everything
// else (verdict breakdown, planner limits, alternatives, triage features) sits under More detail.
function Inspector({ rec, extras, waiting, names, formKey, onDecided }: Shared & { rec: Recommendation; extras?: RecommendationDetail; waiting: boolean }) {
  const e = rec.explanation;
  const s = e.signals ?? {};
  const onHand = s.on_hand;
  const need = s.demand_next_horizon;
  const quantity = Math.floor(rec.quantity);
  const covers = need && need > 0 ? Math.min(1, quantity / need) : undefined;
  const lowersRisk = (rec.risk_after ?? 1) < (rec.risk_before ?? 0);
  // Expected unserved liters: when a stockout is certain either way, this is the impact that still moves.
  const hasShortfall = e.shortfall_before !== undefined && e.shortfall_after !== undefined;
  const saved = hasShortfall ? (e.shortfall_before ?? 0) - (e.shortfall_after ?? 0) : 0;
  const riskNote = lowersRisk
    ? "lower with this shipment"
    : (rec.risk_before ?? 0) >= 1
      ? "certain either way"
      : onHand !== undefined && onHand <= 0
        ? "empty until it arrives"
        : "unchanged within 12 h";
  const reasons = [...new Set([...(e.review_reasons ?? []), ...(e.rule_reasons ?? [])])];
  const station = names.get(rec.station_id) ?? rec.station_id;
  const depot = names.get(rec.depot_id) ?? rec.depot_id;

  return (
    <div className="space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-medium">
            {formatNumber(quantity)} L {humanize(rec.fuel_type).toLowerCase()} to {station}
          </h3>
          <StatusBadge tone={STATUS_TONE[rec.status] ?? statusTone(rec.status)}>{humanize(rec.status)}</StatusBadge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          From {depot}
          {e.transit_ticks !== undefined ? `, ${e.transit_ticks * TICK_MINUTES} min on the road` : ""}
          {e.arrival_tick !== undefined ? `, arrives tick ${e.arrival_tick}` : ""}. Proposed by {sourceLabel(rec)} at tick {rec.tick}.
        </p>
        {e.rl ? <p className="mt-0.5 text-sm text-muted-foreground">{rlSummary(e.rl)}</p> : null}
      </header>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Fact
          label="In stock"
          value={onHand === undefined ? "n/a" : onHand <= 0 ? "Empty" : `${formatNumber(onHand)} L`}
          note={s.capacity ? `of ${formatNumber(s.capacity)} L` : undefined}
          tone={onHand !== undefined && onHand <= 0 ? "bad" : "neutral"}
        />
        <Fact label="Needed, next 12 h" value={need === undefined ? "n/a" : `${formatNumber(need)} L`} />
        <Fact
          label="Stockout risk"
          value={`${formatProbability(rec.risk_before)} → ${formatProbability(rec.risk_after)}`}
          note={riskNote}
          tone={lowersRisk ? "ok" : "warn"}
        />
        {hasShortfall ? (
          <Fact
            label="Expected shortage"
            value={`${formatNumber(e.shortfall_before)} → ${formatNumber(e.shortfall_after)} L`}
            note={saved > 0 ? `${formatNumber(saved)} L less with this shipment` : "unchanged within 12 h"}
            tone={saved > 0 ? "ok" : "neutral"}
          />
        ) : (
          <Fact label="Shipment covers" value={covers === undefined ? "n/a" : `${Math.round(covers * 100)}%`} note="of that need" />
        )}
      </dl>

      {waiting && reasons.length > 0 ? (
        <div className="rounded-md bg-warn-bg px-3 py-2.5 text-sm text-warn-fg">
          <p className="font-medium">Needs your review</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {waiting && extras?.still_valid === false ? (
        <div role="alert" className="rounded-md bg-bad-bg px-3 py-2.5 text-sm text-bad-fg">
          <p className="font-medium">No longer safe to send as proposed</p>
          <ul className="mt-1 list-disc pl-5">
            {(extras.violations ?? []).map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {waiting ? (
        <DecisionForm key={formKey ?? rec.id} rec={rec} onDecided={onDecided} />
      ) : (
        <p className="text-sm text-muted-foreground">No longer waiting for review.</p>
      )}

      {(extras?.decisions.length ?? 0) > 0 || rec.outbox ? (
        <ul className="space-y-1 text-sm">
          {(extras?.decisions ?? []).map((d) => (
            <li key={d.id}>
              {humanize(d.action)} by {d.actor}
              {d.reason ? <span className="text-muted-foreground">: {d.reason}</span> : null}
            </li>
          ))}
          {rec.outbox ? (
            <li className="text-muted-foreground">
              Sent to the simulator: {rec.outbox.status.toLowerCase()}
              {extras?.sim_allocation ? `, shipment ${humanize(extras.sim_allocation.status).toLowerCase()}` : ""}
              {rec.outbox.last_error ? ` (${rec.outbox.last_error})` : ""}
            </li>
          ) : null}
        </ul>
      ) : null}

      <details className="group text-sm">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">More detail</summary>
        <div className="mt-3 space-y-5">
          <dl className="divide-y">
            <Row label="Rule verdict">{rec.rule_verdict ?? "n/a"}</Row>
            <Row label="Final verdict">{rec.verdict}</Row>
            {s.in_transit !== undefined ? <Row label="Already on the way">{formatNumber(s.in_transit)} L</Row> : null}
            {s.demand_multiplier !== undefined && s.demand_multiplier !== 1 ? <Row label="Demand multiplier">×{s.demand_multiplier}</Row> : null}
          </dl>
          {e.binding_constraint ? (
            <p>
              <span className="text-muted-foreground">Quantity limited by: </span>
              {e.binding_constraint}
            </p>
          ) : null}
          {e.rl ? <RLOptions rl={e.rl} /> : null}
          {e.alternatives && e.alternatives.length > 0 ? (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Other routes considered</p>
              <ul className="space-y-1">
                {e.alternatives.map((alt) => (
                  <li key={alt.route_id}>
                    {names.get(alt.depot_id) ?? alt.depot_id}, {alt.transit_ticks * TICK_MINUTES} min: <span className="text-muted-foreground">{alt.rejected}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {e.features ? (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Situation as the triage saw it</p>
              <dl className="divide-y">
                {Object.entries(e.features).map(([key, value]) => (
                  <Row key={key} label={humanize(key)}>
                    {value}
                  </Row>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}

// While a proposal waits, show the queue's copy (always the newest; each tick replaces it) and add
// the detail endpoint's extras only when they are for that same id. Once decided or gone, show the
// last proposal from the detail endpoint.
export function RecommendationInspector({ live, id, ...shared }: Shared & { live?: Recommendation; id?: number }) {
  const detail = useRecommendation(live?.id ?? id);
  if (live) {
    const extras = detail.data?.recommendation.id === live.id ? detail.data : undefined;
    return <Inspector rec={live} extras={extras} waiting {...shared} />;
  }
  if (id === undefined) return <EmptyState>Nothing to review right now</EmptyState>;
  return (
    <QueryBlock query={detail} rows={6}>
      {(data) => <Inspector rec={data.recommendation} extras={data} waiting={data.recommendation.status === "PROPOSED"} {...shared} />}
    </QueryBlock>
  );
}
