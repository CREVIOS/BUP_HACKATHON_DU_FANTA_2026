"use client";

import { CaretRight } from "@phosphor-icons/react";
import { useAllocations, useOverview, useRecommendations, useRLShadow, useStatus } from "@/lib/api/hooks";
import { formatNumber } from "@/lib/format";
import { parseHealth, type Health } from "@/lib/health";
import { probabilities } from "@/lib/rl";
import { cn } from "@/lib/utils";

const RL_VERSION_PREFIX = "ppo-";

interface Stage {
  key: string;
  label: string;
  value: string;
  sub: string;
  health: Health;
  active: boolean; // something is moving through this stage right now
  help: string; // tooltip: what this stage does
}

const DOT: Record<Health, string> = {
  ok: "bg-ok-fg",
  degraded: "bg-warn-fg",
  down: "bg-bad-fg",
  off: "bg-muted-foreground",
  unknown: "bg-muted-foreground",
};

const VALUE_TONE: Record<Health, string> = {
  ok: "",
  degraded: "text-warn-fg",
  down: "text-bad-fg",
  off: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

// The decision loop in one line, left to right, refreshed by the live stream: each tick's snapshot goes
// through the RL policy, triage, human review and the outbox, and the shipments move on the map below.
// Each stage shows what is in it now; hovering explains the stage.
export function PipelineBus() {
  const overview = useOverview();
  const status = useStatus();
  const shadow = useRLShadow(1);
  const recs = useRecommendations({ limit: 50 });
  const allocations = useAllocations();

  const o = overview.data;
  const tick = o?.tick;
  const decision = shadow.data?.decisions[0];
  const confidence = decision?.action != null ? probabilities(decision.logits, decision.mask).find((p) => p.action === decision.action)?.probability : undefined;
  const latestTick = recs.data?.recommendations.reduce((m, r) => Math.max(m, r.tick), -1) ?? -1;
  const latest = recs.data?.recommendations.filter((r) => r.tick === latestTick) ?? [];
  const auto = latest.filter((r) => r.verdict === "auto").length;
  const review = latest.length - auto;
  const rlCards = latest.filter((r) => r.policy_version.startsWith(RL_VERSION_PREFIX)).length;
  const vetoed = latest.filter((r) => (r.explanation.review_reasons ?? []).length > 0).length; // hard veto: straight to review
  const moving = allocations.data?.allocations.filter((a) => a.status === "PENDING" || a.status === "IN_TRANSIT") ?? [];
  const movingLiters = moving.reduce((s, a) => s + a.quantity, 0);
  const queued = allocations.data?.queued.filter((q) => q.status === "PENDING").length ?? 0;
  const age = o?.data_age_seconds;
  const engine = parseHealth(status.data?.decision_engine).health;
  const rlHealth: Health = o?.rl_fallback ? "degraded" : decision?.error ? "degraded" : engine;
  const policy = o?.decision_policy ?? "rl";

  const stages: Stage[] = [
    {
      key: "ingest",
      help: "Reads the whole world between two identical tick reads (a consistent snapshot) and is the single writer. Age = time since the last successful read.",
      label: "Ingestor",
      value: age === undefined ? "–" : age < 1 ? "fresh" : `${age.toFixed(1)} s old`,
      sub: "fenced snapshot, single writer",
      health: age === undefined ? "unknown" : age > 10 ? "down" : o?.stale ? "degraded" : "ok",
      active: age !== undefined && age < 2,
    },
    {
      key: "rl",
      help: "The trained Maskable PPO policy picks one of 13 plans (wait, or 2h/6h/12h cover in 4 modes); the shared planner turns it into feasible shipments. Confidence = its own probability for the chosen plan.",
      label: policy === "rl" ? "RL" : "RL (comparing)",
      value: decision?.error ? "refused" : decision?.strategy ?? "–",
      sub: decision?.error
        ? "greedy stands in"
        : confidence !== undefined
          ? `${Math.round(confidence * 100)}% confident, ${decision?.latency_us ?? "?"} µs`
          : "Maskable PPO, seed 11",
      health: rlHealth,
      active: (decision?.shipments.length ?? 0) > 0,
    },
    {
      key: "triage",
      help: "Every shipment the RL policy proposes is checked here. Hard vetoes (stale data, >5,000 L, an event touching it, RL confidence under 50%) send it straight to review; otherwise the fixed review rule decides: review if a crisis is active, stockout risk stays above 25% after the shipment, or demand is unexplained, else it executes automatically.",
      label: "Triage",
      value: latest.length ? `${auto} auto · ${review} review` : "nothing to ship",
      sub: latest.length
        ? `${rlCards ? `RL proposed ${rlCards}` : `${latest.length} proposed`} · ${vetoed} vetoed`
        : "the review rule decides auto vs review",
      health: "ok",
      active: latest.length > 0 && latestTick === tick,
    },
    {
      key: "review",
      help: "Shipments waiting for an operator to approve or reject (Decisions tab). Approval is re-checked against the live world.",
      label: "Review",
      value: o ? `${o.review_queue} waiting` : "–",
      sub: o?.auto_execute ? "auto-execute on" : "every shipment reviewed",
      health: (o?.review_queue ?? 0) > 0 ? "degraded" : "ok",
      active: (o?.review_queue ?? 0) > 0,
    },
    {
      key: "outbox",
      help: "Approved shipments waiting to be sent. Each is re-validated, then POSTed with an idempotency key so retries can never double-ship.",
      label: "Outbox",
      value: `${queued} queued`,
      sub: "pre-flighted, idempotent",
      health: "ok",
      active: queued > 0,
    },
    {
      key: "ship",
      help: "Allocations accepted by the simulator: waiting at the depot (PENDING) or on the road (IN_TRANSIT). They move on the map below.",
      label: "Shipments",
      value: `${moving.length} moving`,
      sub: moving.length ? `${formatNumber(Math.round(movingLiters))} L on the road` : "none on the road",
      health: "ok",
      active: moving.length > 0,
    },
  ];

  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1.5 text-sm" aria-label="Decision pipeline">
      {stages.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1">
          {i > 0 ? <CaretRight size={12} weight="bold" className="text-muted-foreground/50" aria-hidden /> : null}
          <span title={`${s.help}\n\nNow: ${s.value} (${s.sub})`} className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-muted">
            <span className="relative inline-flex size-1.5" aria-hidden>
              {s.active ? <span className={cn("live-ring absolute inline-flex size-full rounded-full", DOT[s.health])} /> : null}
              <span className={cn("relative inline-flex size-1.5 rounded-full", DOT[s.health])} />
            </span>
            <span className="text-muted-foreground">{s.label}</span>
            <span key={s.value} className={cn("font-medium tabular-nums animate-in fade-in duration-500", VALUE_TONE[s.health])}>
              {s.value}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
