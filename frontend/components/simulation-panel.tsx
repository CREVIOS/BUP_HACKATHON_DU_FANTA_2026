import { Pause, Play } from "@phosphor-icons/react";
import { formatNumber, formatSimTimeShort, humanize } from "@/lib/format";
import type { Overview } from "@/lib/api/schemas";

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-medium tabular-nums">{children}</dd>
    </div>
  );
}

export function SimulationPanel({ overview }: { overview: Overview }) {
  const running = overview.sim_status === "RUNNING";
  const RunIcon = running ? Play : Pause;
  const metrics = overview.sim_metrics;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
      <Stat label="State">
        <span className="flex items-center gap-2">
          <RunIcon size={16} weight="fill" className={running ? "text-ok-fg" : "text-warn-fg"} aria-hidden />
          {humanize(overview.sim_status)}
        </span>
      </Stat>
      <Stat label="Tick">
        <span className="font-mono">{formatNumber(overview.tick)}</span>
      </Stat>
      <Stat label="Sim time">{formatSimTimeShort(overview.sim_time)}</Stat>
      <Stat label="Scenario">{overview.scenario_id}</Stat>
      <Stat label="Service level">
        <span className="font-mono">{metrics ? `${(metrics.service_level * 100).toFixed(1)}%` : "n/a"}</span>
      </Stat>
      <Stat label="Unmet (L)">
        <span className="font-mono">{formatNumber(metrics?.unmet_demand_liters)}</span>
      </Stat>
      <Stat label="Review queue">
        <span className="font-mono">{overview.review_queue}</span>
      </Stat>
      <Stat label="Open alerts">
        <span className="font-mono">
          <span className={overview.open_alerts.critical > 0 ? "text-bad-fg" : ""}>{overview.open_alerts.critical}</span>
          <span className="text-sm text-muted-foreground"> critical, {overview.open_alerts.warn} warn</span>
        </span>
      </Stat>
    </dl>
  );
}
