import { CheckCircle, MinusCircle, Question, Warning, WarningCircle } from "@phosphor-icons/react";
import { ICON } from "@/components/icon-props";
import { Skeleton } from "@/components/ui/skeleton";
import { parseHealth, type Health } from "@/lib/health";
import type { Status } from "@/lib/api/schemas";

const COMPONENTS: readonly { key: string; label: string }[] = [
  { key: "backend_api", label: "Backend API" },
  { key: "database", label: "Database" },
  { key: "fuel_simulator", label: "Fuel simulator" },
  { key: "prediction_service", label: "Prediction service" },
  { key: "decision_engine", label: "Decision engine" },
  { key: "jev", label: "Review triage" },
];

const STATE: Record<Health, { Icon: typeof CheckCircle; className: string; label: string }> = {
  ok: { Icon: CheckCircle, className: "text-ok-fg", label: "Healthy" },
  degraded: { Icon: Warning, className: "text-warn-fg", label: "Degraded" },
  down: { Icon: WarningCircle, className: "text-bad-fg", label: "Unhealthy" },
  off: { Icon: MinusCircle, className: "text-muted-foreground", label: "Off" },
  unknown: { Icon: Question, className: "text-muted-foreground", label: "Unknown" },
};

const REASON_TONE: Record<Health, string> = {
  ok: "",
  degraded: "text-warn-fg",
  down: "text-bad-fg",
  off: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-lg tabular-nums">{value}</dd>
    </div>
  );
}

export function SystemStatus({ status, loading }: { status?: Status; loading: boolean }) {
  const p95 = num(status?.p95_latency_ms);
  const errorRate = num(status?.error_rate);
  const requests = num(status?.requests_5m);
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_auto]">
      <ul className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
        {COMPONENTS.map(({ key, label }) => {
          const { health, reason } = parseHealth(status?.[key]);
          const { Icon, className, label: stateLabel } = STATE[health];
          return (
            <li key={key} className="min-w-0">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span>{label}</span>
                {loading ? (
                  <Skeleton className="size-4 rounded-full motion-reduce:animate-none" />
                ) : (
                  <Icon {...ICON} weight="fill" className={className} role="img" aria-label={stateLabel} />
                )}
              </div>
              {reason && health !== "ok" ? <p className={`mt-0.5 text-xs ${REASON_TONE[health]}`}>{reason}</p> : null}
            </li>
          );
        })}
      </ul>
      <dl className="grid grid-cols-3 gap-6 lg:grid-cols-1 lg:gap-3 lg:border-l lg:pl-8">
        <Metric label="p95 latency" value={p95 === undefined ? "n/a" : `${Math.round(p95)} ms`} />
        <Metric label="Error rate" value={errorRate === undefined ? "n/a" : `${(errorRate * 100).toFixed(1)}%`} />
        <Metric label="Requests, 5 min" value={requests === undefined ? "n/a" : String(requests)} />
      </dl>
    </div>
  );
}
