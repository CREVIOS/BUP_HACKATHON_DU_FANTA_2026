"use client";

import { QueryBlock } from "@/components/query-block";
import { EmptyState } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { DecisionForm } from "@/components/decisions/decision-form";
import { useRecommendation } from "@/lib/api/hooks";
import type { Recommendation, RecommendationDetail } from "@/lib/api/schemas";
import { formatNumber, formatProbability, humanize } from "@/lib/format";
import { statusTone } from "@/lib/tone";

const SIGNALS: readonly [string, string][] = [
  ["on_hand", "On hand (L)"],
  ["in_transit", "In transit (L)"],
  ["capacity", "Capacity (L)"],
  ["reorder_point", "Reorder point (L)"],
  ["demand_next_horizon", "Demand, next 12 h (L)"],
  ["demand_multiplier", "Demand multiplier"],
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

// Risk before and after as two bars on one 0-100% scale, plus the expected shortage in liters: when the network
// is short of fuel a stockout can be certain either way, and the liters are the impact that still moves.
function Impact({
  before,
  after,
  shortBefore,
  shortAfter,
}: {
  before?: number | null;
  after?: number | null;
  shortBefore?: number;
  shortAfter?: number;
}) {
  const bar = (value: number | null | undefined, className: string) => (
    <div className="h-2 flex-1 rounded-full bg-muted" aria-hidden>
      <div className={`h-full rounded-full ${className}`} style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
    </div>
  );
  const hasShort = shortBefore !== undefined && shortAfter !== undefined;
  const saved = hasShort ? shortBefore - shortAfter : 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-sm">
        <span className="w-24 text-muted-foreground">Without</span>
        {bar(before, "bg-bad-fg")}
        <span className="w-12 text-right font-mono tabular-nums">{formatProbability(before)}</span>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <span className="w-24 text-muted-foreground">With shipment</span>
        {bar(after, "bg-ok-fg")}
        <span className="w-12 text-right font-mono tabular-nums">{formatProbability(after)}</span>
      </div>
      <p className="text-xs text-muted-foreground">Probability of a stockout within 12 hours.</p>
      {hasShort ? (
        <p className="text-sm">
          Expected shortage, next 12 h:{" "}
          <span className="font-mono tabular-nums">
            {formatNumber(shortBefore)} L → {formatNumber(shortAfter)} L
          </span>
          {saved > 0 ? <span className="text-ok-fg"> (−{formatNumber(saved)} L)</span> : null}
          {before != null && after != null && before === after && saved > 0 ? (
            <span className="block text-xs text-muted-foreground">
              A stockout is {before >= 1 ? "certain" : "equally likely"} either way; this shipment shrinks it.
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

// The trained RL policy's own account of its choice (brief section 9): the plan it chose, its probability for it,
// the other plans it weighed, and the rule baseline's choice.
function RLBlock({ rl }: { rl: NonNullable<RecommendationDetail["recommendation"]["explanation"]["rl"]> }) {
  return (
    <div className="space-y-2 text-sm">
      <p>
        Chose <span className="font-medium">{rl.strategy}</span> with {Math.round(rl.confidence * 100)}% confidence; this shipment is 1 of{" "}
        {rl.plan_shipments} in the plan ({formatNumber(Math.round(rl.plan_liters))} L). Rule baseline would {rl.baseline_strategy === "wait" ? "wait" : `choose ${rl.baseline_strategy}`}
        {rl.agrees_with_baseline ? " (same)." : "."}
      </p>
      <ul className="space-y-1">
        {rl.options.slice(0, 4).map((o) => (
          <li key={o.action} className="text-xs">
            <div className="flex justify-between gap-2">
              <span className={o.action === rl.action ? "font-medium" : "text-muted-foreground"}>{o.strategy}</span>
              <span className="font-mono tabular-nums text-muted-foreground">{Math.round(o.probability * 100)}%</span>
            </div>
            <div className="mt-0.5 h-1.5 rounded-full bg-muted" aria-hidden>
              <div className={`h-full rounded-full ${o.action === rl.action ? "bg-foreground" : "bg-chart-2"}`} style={{ width: `${Math.max(o.probability * 100, 1)}%` }} />
            </div>
          </li>
        ))}
      </ul>
      <p className="font-mono text-[0.6875rem] text-muted-foreground">{rl.model}</p>
    </div>
  );
}

interface Shared {
  names: ReadonlyMap<string, string>;
  formKey?: string;
  onDecided: (id: number) => void;
}

// `rec` is what to show and decide on; `extras` (validity, violations, trail) only when they belong to it.
function Inspector({ rec, extras, waiting, names, formKey, onDecided }: Shared & { rec: Recommendation; extras?: RecommendationDetail; waiting: boolean }) {
  const e = rec.explanation;
  const reasons = [...(e.review_reasons ?? []), ...(e.rule_reasons ?? [])];
  const uniqueReasons = [...new Set(reasons)];
  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-medium">
            {formatNumber(rec.quantity)} L {humanize(rec.fuel_type).toLowerCase()} to {names.get(rec.station_id) ?? rec.station_id}
          </h3>
          <StatusBadge tone={statusTone(rec.status === "PROPOSED" ? "PENDING" : rec.status === "SUBMITTED" ? "ARRIVED" : rec.status)}>
            {humanize(rec.status)}
          </StatusBadge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          From {names.get(rec.depot_id) ?? rec.depot_id} via {rec.route_id}
          {e.arrival_tick !== undefined ? `, arrives tick ${e.arrival_tick}` : ""}
          {e.transit_ticks !== undefined ? ` (${e.transit_ticks} ticks in transit)` : ""}. Proposed at tick {rec.tick} by{" "}
          {rec.source === "fallback" ? "the fallback policy" : rec.source === "manual" ? "an operator" : `policy ${rec.policy_version}`}.
        </p>
        {waiting ? (
          <p className="mt-1 text-xs text-muted-foreground">Newest proposal for this station and fuel. It refreshes each tick while the simulator runs.</p>
        ) : rec.status !== "PROPOSED" ? (
          <p className="mt-1 text-xs text-muted-foreground">No longer waiting for review.</p>
        ) : null}
      </div>

      <Block title="Expected impact">
        <Impact before={rec.risk_before} after={rec.risk_after} shortBefore={e.shortfall_before} shortAfter={e.shortfall_after} />
      </Block>

      {e.rl ? (
        <Block title="RL policy">
          <RLBlock rl={e.rl} />
        </Block>
      ) : null}

      {waiting && extras?.still_valid === false ? (
        <div role="alert" className="rounded-md bg-bad-bg px-3 py-2 text-sm text-bad-fg">
          <p>No longer safe to execute:</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {(extras?.violations ?? []).map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {waiting ? (
        <Block title="Your decision">
          <DecisionForm key={formKey ?? rec.id} rec={rec} onDecided={onDecided} />
        </Block>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Block title="Why it needs review">
          {uniqueReasons.length === 0 ? (
            <p className="text-sm text-muted-foreground">No review reasons: the rule would allow it to run automatically.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {uniqueReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <dl className="mt-3 divide-y">
            <Row label="Rule verdict">{rec.rule_verdict ?? "n/a"}</Row>
            <Row label="Jev confidence">
              {rec.jev_p_auto == null ? "not asked" : `${formatProbability(rec.jev_p_auto)}${rec.jev_model ? ` (${rec.jev_model})` : ""}`}
            </Row>
            <Row label="Final verdict">{rec.verdict}</Row>
          </dl>
        </Block>

        <Block title="Signals">
          <dl className="divide-y">
            {SIGNALS.filter(([key]) => e.signals?.[key] !== undefined).map(([key, label]) => (
              <Row key={key} label={label}>
                <span className="font-mono tabular-nums">{formatNumber(e.signals?.[key])}</span>
              </Row>
            ))}
          </dl>
          {e.binding_constraint ? (
            <p className="mt-3 text-sm">
              <span className="text-muted-foreground">Quantity capped by: </span>
              {e.binding_constraint}
            </p>
          ) : null}
        </Block>
      </div>

      {e.alternatives && e.alternatives.length > 0 ? (
        <Block title="Alternatives considered">
          <ul className="divide-y text-sm">
            {e.alternatives.map((alt) => (
              <li key={alt.route_id} className="py-2">
                <span className="font-medium">{names.get(alt.depot_id) ?? alt.depot_id}</span>
                <span className="text-muted-foreground"> via {alt.route_id}, {alt.transit_ticks} ticks: </span>
                {alt.rejected}
              </li>
            ))}
          </ul>
        </Block>
      ) : null}

      {e.features ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Situation as the triage saw it</summary>
          <dl className="mt-2 divide-y">
            {Object.entries(e.features).map(([key, value]) => (
              <Row key={key} label={humanize(key)}>
                {value}
              </Row>
            ))}
          </dl>
        </details>
      ) : null}

      {(extras?.decisions.length ?? 0) > 0 || rec.outbox ? (
        <Block title="Trail">
          <ul className="space-y-1 text-sm">
            {(extras?.decisions ?? []).map((d) => (
              <li key={d.id}>
                {humanize(d.action)} by {d.actor}
                {d.reason ? <span className="text-muted-foreground">: {d.reason}</span> : null}
              </li>
            ))}
            {rec.outbox ? (
              <li className="text-muted-foreground">
                Submission {rec.outbox.status.toLowerCase()}
                {rec.outbox.sim_allocation_id ? `, simulator allocation ${rec.outbox.sim_allocation_id}` : ""}
                {extras?.sim_allocation ? ` (${humanize(extras.sim_allocation.status).toLowerCase()})` : ""}
                {rec.outbox.last_error ? `: ${rec.outbox.last_error}` : ""}
              </li>
            ) : null}
          </ul>
        </Block>
      ) : null}
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
