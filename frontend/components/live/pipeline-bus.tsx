"use client";

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

// The whole decision loop as one bus, left to right, refreshed by the live stream: every tick a packet
// travels from the simulator through the RL policy, triage, human review and the outbox back into the
// simulator. Each stage shows what is in it now.
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
  const moving = allocations.data?.allocations.filter((a) => a.status === "PENDING" || a.status === "IN_TRANSIT") ?? [];
  const movingLiters = moving.reduce((s, a) => s + a.quantity, 0);
  const queued = allocations.data?.queued.filter((q) => q.status === "PENDING").length ?? 0;
  const age = o?.data_age_seconds;
  const engine = parseHealth(status.data?.decision_engine).health;
  const rlHealth: Health = o?.rl_fallback ? "degraded" : decision?.error ? "degraded" : engine;
  const policy = o?.decision_policy ?? "rl";

  const stages: Stage[] = [
    {
      key: "sim",
      help: "The organizer simulator: advances one tick (15 simulated minutes) at a time. Only the ingestor talks to it, at most 4 requests at once.",
      label: "Simulator",
      value: tick === undefined ? "–" : `tick ${tick}`,
      sub: o ? o.sim_status.toLowerCase() : "connecting",
      health: parseHealth(status.data?.fuel_simulator).health,
      active: o?.sim_status === "RUNNING",
    },
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
      label: policy === "rl" ? "RL policy" : "RL (comparing)",
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
      help: "Each proposed shipment is checked: hard vetoes (stale data, >5,000 L, an event touching it, low model confidence) force review; otherwise Jev or the fixed rule decides auto vs review.",
      label: "Triage",
      value: latest.length ? `${auto} auto · ${review} review` : "nothing to ship",
      sub: rlCards ? `${rlCards} from the RL policy` : "hard vetoes, Jev, rule",
      health: "ok",
      active: latest.length > 0 && latestTick === tick,
    },
    {
      key: "review",
      help: "Shipments waiting for an operator to approve or reject (Decisions tab). Approval is re-checked against the live world.",
      label: "Human review",
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
    <div className="relative">
      {/* the bus: a flowing line behind the stages, and one packet per tick */}
      <div aria-hidden className="pointer-events-none absolute inset-x-6 top-1/2 hidden h-px -translate-y-1/2 lg:block">
        <svg className="absolute inset-0 h-px w-full overflow-visible" preserveAspectRatio="none">
          <line x1="0" y1="0" x2="100%" y2="0" className={cn("stroke-border", o?.sim_status === "RUNNING" && "live-flow stroke-chart-3")} strokeWidth="1.5" />
        </svg>
        {tick !== undefined ? <span key={tick} className="live-packet absolute top-1/2 size-2 -translate-y-1/2 rounded-full bg-foreground" /> : null}
      </div>
      <ol className="relative grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {stages.map((s, i) => (
          <li
            key={s.key}
            title={`${s.label}: ${s.help}\n\nNow: ${s.value} (${s.sub})`}
            className={cn(
              "min-w-0 rounded-lg border bg-card px-3 py-2.5 transition-colors duration-500",
              s.active && "border-chart-3",
              s.health === "down" && "border-bad-fg",
              s.health === "degraded" && "border-warn-fg",
            )}
          >
            <div className="flex items-center gap-1.5 text-[0.6875rem] font-medium tracking-wider text-muted-foreground uppercase">
              <span className="relative inline-flex size-1.5">
                {s.active ? <span className={cn("live-ring absolute inline-flex size-full rounded-full", DOT[s.health])} /> : null}
                <span className={cn("relative inline-flex size-1.5 rounded-full", DOT[s.health])} />
              </span>
              <span className="truncate">
                {i + 1}. {s.label}
              </span>
            </div>
            <p key={s.value} className="mt-1 truncate text-sm font-medium tabular-nums animate-in fade-in duration-500" title={s.value}>
              {s.value}
            </p>
            <p className="truncate text-xs text-muted-foreground" title={s.sub}>
              {s.sub}
            </p>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-muted-foreground">
        Every tick: the simulator is read, the {policy === "rl" ? "trained RL policy proposes" : "greedy heuristic proposes (RL compared)"} shipments,
        triage sends each to auto-execute or a human, approved ones leave through the outbox, and the fuel moves on the map below.
      </p>
    </div>
  );
}
