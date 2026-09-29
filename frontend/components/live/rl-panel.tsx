"use client";

import { StatusBadge } from "@/components/status-badge";
import { useOverview, useRL, useRLShadow } from "@/lib/api/hooks";
import { formatNumber } from "@/lib/format";
import { probabilities } from "@/lib/rl";
import { cn } from "@/lib/utils";

// What the trained RL policy decided this tick and why it chose it over the alternatives: its own probability
// for every valid plan (softmax of the actor's outputs over the valid actions), the rule baseline's choice, and
// the recent decision history.
export function RLPanel() {
  const rl = useRL();
  const shadow = useRLShadow(32);
  const overview = useOverview();
  const decisions = shadow.data?.decisions ?? [];
  const d = decisions[0];
  const options = d ? probabilities(d.logits, d.mask).slice(0, 5) : [];
  const liters = d?.shipments.reduce((s, x) => s + x.quantity, 0) ?? 0;
  const deciding = (overview.data?.decision_policy ?? rl.data?.decision_policy) === "rl";
  const live = rl.data?.live;
  const agree = live && live.ticks_decided ? Math.round((100 * live.agrees_with_planner_baseline) / live.ticks_decided) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Trained RL policy</p>
          <p className="truncate font-mono text-[0.6875rem] text-muted-foreground" title={rl.data?.model.repo}>
            {rl.data ? `Maskable PPO · seed ${rl.data.model.seed} · ${rl.data.model.revision.slice(0, 7)}` : "loading"}
          </p>
        </div>
        <span title={overview.data?.rl_fallback ? "The policy refused this tick (untrusted data); the greedy heuristic decided instead." : deciding ? "The trained RL policy is the active decision policy: its plans become the recommendations." : "Greedy decides; the RL policy runs beside it for comparison."}>
        <StatusBadge tone={overview.data?.rl_fallback ? "warn" : deciding ? "ok" : "neutral"}>
          {overview.data?.rl_fallback ? "fallback" : deciding ? "deciding" : "comparing"}
        </StatusBadge>
        </span>
      </div>

      <div className="rounded-lg border bg-card p-3">
        <p className="text-[0.6875rem] font-medium tracking-wider text-muted-foreground uppercase">Tick {d?.tick ?? "–"} decision</p>
        {d?.error ? (
          <p className="mt-1 text-sm text-warn-fg">Refused this tick ({d.error}); greedy decided instead.</p>
        ) : (
          <>
            <p key={`${d?.tick}-${d?.strategy}`} className="mt-1 text-base font-medium animate-in fade-in slide-in-from-bottom-1 duration-500">
              {d?.strategy ?? "–"}
            </p>
            <p className="text-xs text-muted-foreground">
              {d?.shipments.length ? `${d.shipments.length} shipments, ${formatNumber(Math.round(liters))} L` : "no shipment this tick"}
              {d?.baseline_strategy ? ` · rule baseline: ${d.baseline_strategy}` : ""}
            </p>
          </>
        )}
        {options.length ? (
          <ul className="mt-3 flex flex-col gap-1.5" aria-label="The policy's probability for each valid plan" title="The policy's own probability for each valid plan (softmax of its outputs over the valid actions). ▸ marks the plan it chose.">
            {options.map((o) => (
              <li key={o.action} className="text-xs" title={`${o.strategy}: ${(o.probability * 100).toFixed(1)}% probability${o.action === d?.action ? " (chosen)" : ""}`}>
                <div className="flex justify-between gap-2">
                  <span className={cn("truncate", o.action === d?.action ? "font-medium" : "text-muted-foreground")}>
                    {o.action === d?.action ? "▸ " : ""}
                    {o.strategy}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{Math.round(o.probability * 100)}%</span>
                </div>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", o.action === d?.action ? "bg-foreground" : "bg-chart-2")}
                    style={{ width: `${Math.max(o.probability * 100, 1)}%`, transition: "width 600ms ease" }}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div>
        <p className="mb-1.5 text-[0.6875rem] font-medium tracking-wider text-muted-foreground uppercase" title="One square per tick, oldest first. Hover a square for that tick's decision.">Last {decisions.length} ticks</p>
        <div className="flex flex-wrap gap-1" aria-label="Recent decisions, oldest first">
          {[...decisions].reverse().map((x) => (
            <span
              key={x.tick}
              title={`tick ${x.tick}: ${x.error ? `refused (${x.error})` : x.strategy}`}
              className={cn(
                "size-3 rounded-sm animate-in fade-in zoom-in-50 duration-300",
                x.error ? "bg-bad-fg" : x.action ? "bg-foreground" : "bg-chart-1",
              )}
            />
          ))}
        </div>
        <p className="mt-1.5 text-[0.6875rem] text-muted-foreground">■ shipped &nbsp; ■ waited (lighter) &nbsp; red = refused</p>
      </div>

      {live ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <div>
            <dt className="text-muted-foreground" title="Ticks the policy evaluated in this simulator run">Ticks decided</dt>
            <dd className="font-medium tabular-nums">{formatNumber(live.ticks_decided)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground" title="Ticks it refused to decide (stale or untrusted data); greedy decided those">Refusals</dt>
            <dd className="font-medium tabular-nums">{live.errors}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground" title="Share of ticks where it chose the same plan as the planner's rule-based baseline">Same as rule baseline</dt>
            <dd className="font-medium tabular-nums">{agree === undefined ? "–" : `${agree}%`}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground" title="Average time to build the observation, run the planner and the network, per tick">Decision time</dt>
            <dd className="font-medium tabular-nums">{live.avg_latency_us == null ? "–" : `${(live.avg_latency_us / 1000).toFixed(2)} ms`}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}
