"use client";

import { Info, Warning, WarningOctagon } from "@phosphor-icons/react";
import { useState } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { ActionError } from "@/components/action-error";
import { useNavigate } from "@/components/navigation";
import { ICON, ICON_SM } from "@/components/icon-props";
import { QueryBlock } from "@/components/query-block";
import { EmptyState } from "@/components/section";
import { Button } from "@/components/ui/button";
import { useAccess } from "@/hooks/use-access";
import { useAckAlert, useAlerts } from "@/lib/api/hooks";
import type { Alert, Severity } from "@/lib/api/schemas";
import { formatNumber, formatProbability, humanize, stockoutLabel } from "@/lib/format";
import { describeSubject } from "@/lib/names";
import { alertTarget } from "@/lib/targets";

const SEVERITY: Record<Severity, { Icon: typeof Info; className: string }> = {
  CRITICAL: { Icon: WarningOctagon, className: "text-bad-fg" },
  WARN: { Icon: Warning, className: "text-warn-fg" },
  INFO: { Icon: Info, className: "text-info-fg" },
};
const COLLAPSED = 6;

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

// One line of context per alert kind (docs/API.md section 7).
function summary(alert: Alert): string {
  const d = alert.detail ?? {};
  if (typeof d.message === "string") return d.message;
  if (alert.kind === "stockout_risk") {
    const onHand = num(d.on_hand) ?? 0;
    if (onHand <= 0) return `Out of stock, ${formatNumber(num(d.demand_next_12h))} L of demand in the next 12 h`;
    const label = stockoutLabel(num(d.time_to_stockout_hours), onHand);
    return `Stockout ${label === "now" ? "now" : `in ${label}`}, probability ${formatProbability(num(d.stockout_prob))}`;
  }
  if (alert.kind === "disruption" || alert.kind === "disruption_upcoming") {
    return `${humanize(String(d.type ?? "event"))}, ticks ${String(d.start_tick ?? "?")} to ${String(d.end_tick ?? "?")}`;
  }
  return "";
}

export function AlertsPanel({ names }: { names: ReadonlyMap<string, string> }) {
  const alerts = useAlerts({ state: "open" });
  const ack = useAckAlert();
  const access = useAccess();
  const [expanded, setExpanded] = useState(false);
  const go = useNavigate();

  return (
    <QueryBlock query={alerts}>
      {(data) => {
        if (data.alerts.length === 0) return <EmptyState>No open alerts</EmptyState>;
        const shown = expanded ? data.alerts : data.alerts.slice(0, COLLAPSED);
        return (
          <div className="space-y-3">
            <ul className="divide-y">
              {shown.map((alert) => {
                const { Icon, className } = SEVERITY[alert.severity];
                return (
                  <li key={alert.id} className="flex gap-3 py-2.5">
                    <Icon {...ICON} weight="fill" className={`mt-0.5 shrink-0 ${className}`} role="img" aria-label={alert.severity.toLowerCase()} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        <span className="font-medium">{humanize(alert.kind)}</span>
                        {alert.subject ? <span className="text-muted-foreground"> · {describeSubject(alert.subject, names)}</span> : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {summary(alert)}
                        {alert.tick != null ? ` · since tick ${alert.tick}` : ""}
                      </p>
                    </div>
                    <Button variant="ghost" size="xs" className="shrink-0 self-center" onClick={() => go(alertTarget(alert))} aria-label={`Open ${humanize(alert.kind)}`}>
                      Open
                      <ArrowRight {...ICON_SM} aria-hidden />
                    </Button>
                    {alert.acked_by ? (
                      <span className="shrink-0 self-center text-xs text-muted-foreground">Acked by {alert.acked_by}</span>
                    ) : access.can("ack") ? (
                      <Button
                        variant="outline"
                        size="xs"
                        className="shrink-0 self-center"
                        disabled={ack.isPending}
                        onClick={() => ack.mutate(alert.id)}
                      >
                        Acknowledge
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {data.alerts.length > COLLAPSED ? (
              <Button variant="ghost" size="xs" onClick={() => setExpanded((v) => !v)}>
                {expanded ? "Show fewer" : `Show all ${data.alerts.length}`}
              </Button>
            ) : null}
            <ActionError error={ack.error} />
          </div>
        );
      }}
    </QueryBlock>
  );
}
