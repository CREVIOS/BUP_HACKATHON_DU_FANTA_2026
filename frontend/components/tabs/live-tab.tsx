"use client";

import { NetworkMap } from "@/components/map/network-map";
import { PipelineBus } from "@/components/live/pipeline-bus";
import { RLPanel } from "@/components/live/rl-panel";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { useOverview, useRecommendations } from "@/lib/api/hooks";
import { formatNumber, formatSimTime } from "@/lib/format";
import { statusTone } from "@/lib/tone";

// The live picture: the decision pipeline as a bus, the network map with moving shipments, and the RL policy
// deciding, all refreshed by the stream every tick.
export function LiveTab({ names }: { names: ReadonlyMap<string, string> }) {
  const overview = useOverview();
  const recs = useRecommendations({ limit: 12 });
  const o = overview.data;
  const rl = (recs.data?.recommendations ?? []).filter((r) => r.policy_version.startsWith("ppo-")).slice(0, 6);
  return (
    <>
      <Section
        title="Decision pipeline"
        action={
          o ? (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <StatusBadge tone={statusTone(o.sim_status)}>{o.sim_status.toLowerCase()}</StatusBadge>
              <span className="tabular-nums">
                tick {o.tick} · {formatSimTime(o.sim_time)}
              </span>
            </span>
          ) : null
        }
      >
        <PipelineBus />
      </Section>
      <section className="grid gap-8 border-t py-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <h2 className="mb-4 text-sm font-medium">Network, live</h2>
          <NetworkMap names={names} />
        </div>
        <RLPanel />
      </section>
      <Section title="Latest RL recommendations">
        {rl.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No RL shipment proposed recently: the policy chose to wait.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {rl.map((r) => (
              <li
                key={r.id}
                title={`Proposed by the RL policy at tick ${r.tick}. Verdict ${r.verdict}: ${r.verdict === "auto" ? "executes without a human" : "waits for an operator in the Decisions tab"}. Status ${r.status.toLowerCase()}.`}
                className="rounded-lg border bg-card p-3 text-sm animate-in fade-in slide-in-from-bottom-1 duration-500"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">
                    {names.get(r.station_id) ?? r.station_id} · {r.fuel_type.toLowerCase()}
                  </span>
                  <StatusBadge tone={r.verdict === "auto" ? "ok" : "warn"}>{r.verdict}</StatusBadge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatNumber(Math.round(r.quantity))} L via {names.get(r.depot_id) ?? r.depot_id} · tick {r.tick} ·{" "}
                  {r.status.toLowerCase()}
                </p>
                {r.explanation.rl ? (
                  <p className="mt-1 text-xs">
                    {r.explanation.rl.strategy}, {Math.round(r.explanation.rl.confidence * 100)}% confident
                    {r.risk_before != null && r.risk_after != null
                      ? ` · risk ${Math.round(r.risk_before * 100)}% → ${Math.round(r.risk_after * 100)}%`
                      : ""}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
