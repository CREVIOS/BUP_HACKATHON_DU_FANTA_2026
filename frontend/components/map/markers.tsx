"use client";

import { Popover } from "@base-ui/react/popover";
import { RouteCard } from "@/components/map/route-card";
import { SiteCard } from "@/components/map/site-card";
import type { Allocation } from "@/lib/api/schemas";
import { formatHours, formatNumber, humanize } from "@/lib/format";
import { MAP_HEIGHT, MAP_WIDTH } from "@/lib/map/bangladesh";
import { pointOnRoute, shipmentProgress, type MapFuel, type MapRoute, type MapSite, type SiteLevel } from "@/lib/map/model";
import type { Target } from "@/lib/targets";
import { cn } from "@/lib/utils";

const DOT: Record<SiteLevel, string> = {
  normal: "bg-foreground",
  elevated: "bg-warn-fg",
  critical: "bg-bad-fg",
  empty: "bg-bad-fg",
  outage: "bg-bad-fg",
};
const DEPOT: Record<SiteLevel, string> = {
  normal: "border-foreground",
  elevated: "border-warn-fg",
  critical: "border-bad-fg",
  empty: "border-bad-fg",
  outage: "border-bad-fg",
};
const TANK: Partial<Record<string, string>> = { elevated: "bg-warn-fg", high: "bg-bad-fg", critical: "bg-bad-fg" };
const POPUP =
  "w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-[0_12px_32px_-12px_rgb(17_17_17/0.25)] outline-none transition-[opacity,transform] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none dark:shadow-none";
// Markers not connected to what the pointer is on fade back, so the traced routes stand out.
const DIMMED = "opacity-35";

export const pct = (x: number, y: number) => ({ left: `${(x / MAP_WIDTH) * 100}%`, top: `${(y / MAP_HEIGHT) * 100}%` });

export interface MarkerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGo: (target: Target) => void;
  onHover: (on: boolean) => void; // pointer or keyboard focus is on this marker
  dimmed: boolean;
}

const hoverHandlers = (onHover: (on: boolean) => void) => ({
  onPointerEnter: () => onHover(true),
  onPointerLeave: () => onHover(false),
  onFocus: () => onHover(true),
  onBlur: () => onHover(false),
});

function shortName(site: MapSite): string {
  const base = site.name.replace(/ (Fuel|Industrial|Highway|Regional) Station$| Station$| Depot$/, "");
  return site.kind === "depot" ? `${base} depot` : base;
}

function summary(site: MapSite): string {
  if (site.kind === "depot") return `lowest ${Math.round(Math.min(...site.fuels.map((f) => f.fill)) * 100)}%`;
  if (site.level === "outage") return "outage";
  const empty = site.fuels.filter((f) => f.inventory <= 0).length;
  if (empty > 0) return `${empty} ${empty === 1 ? "fuel" : "fuels"} empty`;
  const soonest = Math.min(...site.fuels.map((f) => (typeof f.hours === "number" && f.hours >= 0 ? f.hours : Infinity)));
  if (site.level === "critical" && Number.isFinite(soonest)) return `out in ${formatHours(soonest)}`;
  if (site.spike) return `demand ×${site.spike.toFixed(2)}`;
  return site.level === "elevated" ? "at risk" : "OK";
}

// Diesel, petrol, octane: each bar fills and drains with the tank, coloured by stockout risk.
export function TankBars({ fuels }: { fuels: MapFuel[] }) {
  return (
    <span className="flex h-3 items-end gap-px" aria-hidden>
      {fuels.map((f) => (
        <span key={f.fuel} className="relative h-full w-1 overflow-hidden rounded-[1px] bg-foreground/15">
          <span
            className={cn("absolute inset-x-0 bottom-0 transition-[height] duration-700 motion-reduce:transition-none", TANK[f.risk ?? ""] ?? "bg-foreground/70")}
            style={{ height: `${Math.round(Math.min(Math.max(f.fill, 0), 1) * 100)}%` }}
          />
        </span>
      ))}
    </span>
  );
}

export function SiteMarker({ site, open, onOpenChange, onGo, onHover, dimmed }: MarkerProps & { site: MapSite }) {
  const left = site.pos.side === "left";
  const critical = site.alerts.some((a) => a.severity === "CRITICAL");
  const urgent = site.kind === "station" && (site.level === "empty" || site.level === "critical" || site.level === "outage");
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        aria-label={`${site.name}: ${summary(site)}${site.alerts.length ? `, ${site.alerts.length} open ${site.alerts.length === 1 ? "alert" : "alerts"}` : ""}`}
        style={pct(site.pos.x, site.pos.y)}
        {...hoverHandlers(onHover)}
        className={cn(
          "absolute z-10 flex -translate-y-1/2 items-center gap-1.5 rounded-md px-1 py-0.5 text-left outline-none transition-[background-color,opacity] duration-200 hover:bg-background/80 focus-visible:ring-2 focus-visible:ring-ring/60 data-[popup-open]:bg-background/80 motion-reduce:transition-none",
          left ? "-translate-x-[calc(100%-11px)] flex-row-reverse text-right" : "-translate-x-[11px]",
          dimmed && DIMMED,
        )}
      >
        <span className="relative grid size-3.5 shrink-0 place-items-center" aria-hidden>
          {urgent ? <span className="absolute inset-0 rounded-full bg-bad-fg/50 motion-safe:animate-ping" /> : null}
          {site.spike ? <span className="live-glow absolute -inset-1 rounded-full ring-2 ring-warn-fg" /> : null}
          {site.kind === "station" ? (
            <span className={cn("relative size-3.5 rounded-full ring-2 ring-background", DOT[site.level])} />
          ) : (
            <span className={cn("relative size-3 rounded-[2px] border-2 bg-background", DEPOT[site.level])} />
          )}
        </span>
        <span className={cn("flex flex-col leading-tight whitespace-nowrap", left && "items-end")}>
          <span className={cn("flex items-center gap-1.5", left && "flex-row-reverse")}>
            <span className="text-xs font-medium">{shortName(site)}</span>
            {site.alerts.length > 0 ? (
              <span className={cn("rounded-full px-1.5 text-[0.625rem] font-medium", critical ? "bg-bad-bg text-bad-fg" : "bg-warn-bg text-warn-fg")}>
                {site.alerts.length} {site.alerts.length === 1 ? "alert" : "alerts"}
              </span>
            ) : null}
          </span>
          <span className={cn("flex items-center gap-1.5 text-[0.6875rem]", left && "flex-row-reverse", urgent ? "text-bad-fg" : site.spike ? "text-warn-fg" : "text-muted-foreground")}>
            <TankBars fuels={site.fuels} />
            {summary(site)}
          </span>
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={left ? "left" : "right"} sideOffset={10} collisionPadding={12} className="z-50">
          <Popover.Popup className={POPUP}>
            <SiteCard site={site} onGo={onGo} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function RouteMarker({ route, names, open, onOpenChange, onGo, onHover, dimmed }: MarkerProps & { route: MapRoute; names: ReadonlyMap<string, string> }) {
  const mid = pointOnRoute(route, 0.5);
  const label = route.state === "disrupted" ? "Disrupted route" : "Disruption planned";
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        aria-label={`${label}: ${route.route.id}`}
        style={pct(mid.x, mid.y)}
        {...hoverHandlers(onHover)}
        className={cn(
          "absolute z-0 size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] ring-2 ring-background outline-none transition-opacity duration-200 focus-visible:ring-ring/60 motion-reduce:transition-none",
          route.state === "disrupted" ? "bg-bad-fg" : "bg-warn-fg",
          dimmed && DIMMED,
        )}
      />
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} collisionPadding={12} className="z-50">
          <Popover.Popup className={POPUP}>
            <RouteCard route={route} names={names} onGo={onGo} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// A truck at its place along the route, moving each tick. Filled: a FuelOps shipment; hollow: the simulator's own.
export function ShipmentMarker({ shipment, route, tick, names, open, onOpenChange, onGo, onHover, dimmed }: MarkerProps & { shipment: Allocation; route: MapRoute; tick: number; names: ReadonlyMap<string, string> }) {
  const at = pointOnRoute(route, shipmentProgress(shipment, tick));
  const waiting = shipment.status === "PENDING";
  const ours = shipment.origin === "fuelops";
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        aria-label={`${formatNumber(Math.round(shipment.quantity))} L ${humanize(shipment.fuel_type).toLowerCase()} to ${names.get(shipment.destination_station_id) ?? shipment.destination_station_id}, ${waiting ? "waiting to depart" : "on the road"}`}
        style={pct(at.x, at.y)}
        {...hoverHandlers(onHover)}
        className={cn(
          "absolute z-[5] grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full outline-none [transition:left_900ms_linear,top_900ms_linear,opacity_200ms] focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none",
          dimmed && DIMMED,
        )}
      >
        {waiting ? <span className="live-ring absolute inset-0.5 rounded-full border border-foreground" aria-hidden /> : null}
        <span className={cn("size-2.5 rounded-full border-2 border-foreground ring-2 ring-background", ours ? "bg-foreground" : "bg-background")} aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} collisionPadding={12} className="z-50">
          <Popover.Popup className={POPUP}>
            <RouteCard route={route} names={names} onGo={onGo} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
