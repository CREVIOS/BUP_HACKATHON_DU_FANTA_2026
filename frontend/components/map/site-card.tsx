"use client";

import { Popover } from "@base-ui/react/popover";
import { ArrowRight, Info, Warning, WarningOctagon } from "@phosphor-icons/react";
import { ICON_SM } from "@/components/icon-props";
import { StatusBadge } from "@/components/status-badge";
import type { Alert, Severity } from "@/lib/api/schemas";
import { formatNumber, formatPercent, humanize, stockoutLabel } from "@/lib/format";
import type { MapFuel, MapSite } from "@/lib/map/model";
import { seriesKey } from "@/lib/queue";
import { alertTarget, type Target } from "@/lib/targets";
import { statusTone } from "@/lib/tone";

const SEVERITY: Record<Severity, { Icon: typeof Info; className: string }> = {
  CRITICAL: { Icon: WarningOctagon, className: "text-bad-fg" },
  WARN: { Icon: Warning, className: "text-warn-fg" },
  INFO: { Icon: Info, className: "text-info-fg" },
};

function fuelState(site: MapSite, f: MapFuel): { text: string; className: string } {
  if (f.inventory <= 0) return { text: "Empty", className: "text-bad-fg font-medium" };
  if (site.kind === "depot") return { text: formatPercent(f.fill), className: f.fill < 0.1 ? "text-bad-fg" : "text-muted-foreground" };
  const text = stockoutLabel(f.hours, f.inventory);
  const risky = f.risk === "critical" || f.risk === "high";
  return { text: text === "none in 12 h" ? "OK for 12 h" : `out in ${text}`, className: risky ? "text-bad-fg" : f.risk === "elevated" ? "text-warn-fg" : "text-muted-foreground" };
}

function alertLine(alert: Alert): string {
  const fuel = (alert.subject ?? "").split(":")[1];
  return `${humanize(alert.kind)}${fuel ? `, ${humanize(fuel).toLowerCase()}` : ""}`;
}

function LinkRow({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
      >
        {children}
        <ArrowRight {...ICON_SM} className="ml-auto shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
      </button>
    </li>
  );
}

// The card a map marker opens: stock per fuel, then every alert and pending decision as a link to
// the page where it can be handled.
export function SiteCard({ site, onGo }: { site: MapSite; onGo: (target: Target) => void }) {
  const section = site.kind === "station" ? "stations" : "depots";
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2">
          <Popover.Title className="font-medium">{site.name}</Popover.Title>
          {site.status !== "OPEN" ? <StatusBadge tone={statusTone(site.status)}>{humanize(site.status)}</StatusBadge> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {site.kind === "depot" ? "Depot" : "Station"}
          {site.dispatchLeft !== undefined ? `, ${formatNumber(site.dispatchLeft)} L can still leave this tick` : ""}
        </p>
      </div>

      <table className="w-full text-sm">
        <tbody>
          {site.fuels.map((f) => {
            const state = fuelState(site, f);
            return (
              <tr key={f.fuel}>
                <td className="py-0.5 text-muted-foreground">{humanize(f.fuel)}</td>
                <td className="py-0.5 text-right font-mono tabular-nums">{formatNumber(f.inventory)} L</td>
                <td className={`py-0.5 pl-3 text-right text-xs ${state.className}`}>{state.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {site.alerts.length > 0 ? (
        <div>
          <p className="mb-0.5 text-xs text-muted-foreground">Open alerts</p>
          <ul className="-mx-2">
            {site.alerts.slice(0, 5).map((alert) => {
              const { Icon, className } = SEVERITY[alert.severity];
              return (
                <LinkRow key={alert.id} onClick={() => onGo(alertTarget(alert))}>
                  <Icon {...ICON_SM} weight="fill" className={`shrink-0 ${className}`} role="img" aria-label={alert.severity.toLowerCase()} />
                  <span className="truncate">{alertLine(alert)}</span>
                </LinkRow>
              );
            })}
          </ul>
        </div>
      ) : null}

      {site.pending.length > 0 ? (
        <div>
          <p className="mb-0.5 text-xs text-muted-foreground">Waiting for your review</p>
          <ul className="-mx-2">
            {site.pending.map((rec) => (
              <LinkRow key={rec.id} onClick={() => onGo({ tab: "decisions", seriesKey: seriesKey(rec) })}>
                <span>
                  {humanize(rec.fuel_type)} <span className="font-mono tabular-nums">{formatNumber(Math.floor(rec.quantity))} L</span>
                </span>
              </LinkRow>
            ))}
          </ul>
        </div>
      ) : null}

      <ul className="-mx-2 border-t pt-1">
        <LinkRow onClick={() => onGo({ tab: "network", section })}>
          <span className="text-muted-foreground">Open in Network</span>
        </LinkRow>
      </ul>
    </div>
  );
}
