"use client";

import { Popover } from "@base-ui/react/popover";
import { useMemo, useState } from "react";
import { RouteCard } from "@/components/map/route-card";
import { SiteCard } from "@/components/map/site-card";
import { useNavigate } from "@/components/navigation";
import { QueryBlock } from "@/components/query-block";
import { useAlerts, useAllocations, useNetwork, useOverview, useRecommendations } from "@/lib/api/hooks";
import type { Allocation } from "@/lib/api/schemas";
import { formatHours, formatNumber, humanize } from "@/lib/format";
import { COUNTRY_PATH, DIVISIONS, MAP_HEIGHT, MAP_WIDTH } from "@/lib/map/bangladesh";
import { buildMapModel, pointOnRoute, routeCurve, shipmentProgress, type MapFuel, type MapRoute, type MapSite, type SiteLevel } from "@/lib/map/model";
import { divisionOf } from "@/lib/map/sites";
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
const ROUTE: Record<MapRoute["state"], string> = {
  ok: "stroke-foreground/30",
  scheduled: "stroke-warn-fg",
  disrupted: "stroke-bad-fg",
};
const TANK: Partial<Record<string, string>> = { elevated: "bg-warn-fg", high: "bg-bad-fg", critical: "bg-bad-fg" };
const POPUP =
  "w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-[0_12px_32px_-12px_rgb(17_17_17/0.25)] outline-none transition-[opacity,transform] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none dark:shadow-none";

const pct = (x: number, y: number) => ({ left: `${(x / MAP_WIDTH) * 100}%`, top: `${(y / MAP_HEIGHT) * 100}%` });

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

function routePath(route: MapRoute): string {
  const { from, control, to } = routeCurve(route);
  return `M${from.x},${from.y} Q${control.x},${control.y} ${to.x},${to.y}`;
}

// Diesel, petrol, octane: each bar fills and drains with the tank, coloured by stockout risk.
function TankBars({ fuels }: { fuels: MapFuel[] }) {
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

function SiteMarker({ site, open, onOpenChange, onGo }: { site: MapSite; open: boolean; onOpenChange: (open: boolean) => void; onGo: (t: Target) => void }) {
  const left = site.pos.side === "left";
  const critical = site.alerts.some((a) => a.severity === "CRITICAL");
  const urgent = site.kind === "station" && (site.level === "empty" || site.level === "critical" || site.level === "outage");
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        aria-label={`${site.name}: ${summary(site)}${site.alerts.length ? `, ${site.alerts.length} open ${site.alerts.length === 1 ? "alert" : "alerts"}` : ""}`}
        style={pct(site.pos.x, site.pos.y)}
        className={cn(
          "absolute z-10 flex -translate-y-1/2 items-center gap-1.5 rounded-md px-1 py-0.5 text-left outline-none transition-colors hover:bg-background/80 focus-visible:ring-2 focus-visible:ring-ring/60 data-[popup-open]:bg-background/80",
          left ? "-translate-x-[calc(100%-11px)] flex-row-reverse text-right" : "-translate-x-[11px]",
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

function RouteMarker({ route, names, open, onOpenChange, onGo }: { route: MapRoute; names: ReadonlyMap<string, string>; open: boolean; onOpenChange: (open: boolean) => void; onGo: (t: Target) => void }) {
  const mid = pointOnRoute(route, 0.5);
  const label = route.state === "disrupted" ? "Disrupted route" : "Disruption planned";
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        aria-label={`${label}: ${route.route.id}`}
        style={pct(mid.x, mid.y)}
        className={cn(
          "absolute z-0 size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] ring-2 ring-background outline-none focus-visible:ring-ring/60",
          route.state === "disrupted" ? "bg-bad-fg" : "bg-warn-fg",
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
function ShipmentMarker({ shipment, route, tick, names, open, onOpenChange, onGo }: { shipment: Allocation; route: MapRoute; tick: number; names: ReadonlyMap<string, string>; open: boolean; onOpenChange: (open: boolean) => void; onGo: (t: Target) => void }) {
  const at = pointOnRoute(route, shipmentProgress(shipment, tick));
  const waiting = shipment.status === "PENDING";
  const ours = shipment.origin === "fuelops";
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        aria-label={`${formatNumber(Math.round(shipment.quantity))} L ${humanize(shipment.fuel_type).toLowerCase()} to ${names.get(shipment.destination_station_id) ?? shipment.destination_station_id}, ${waiting ? "waiting to depart" : "on the road"}`}
        style={pct(at.x, at.y)}
        className="absolute z-[5] grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full outline-none transition-[left,top] duration-[900ms] ease-linear focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
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

const LEGEND_TANKS: MapFuel[] = [
  { fuel: "DIESEL", inventory: 1, capacity: 1, fill: 0.8 },
  { fuel: "PETROL", inventory: 1, capacity: 1, fill: 0.5 },
  { fuel: "OCTANE", inventory: 1, capacity: 1, fill: 0.3 },
];

function Legend() {
  return (
    <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
      <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-foreground" aria-hidden />Station OK</li>
      <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-warn-fg" aria-hidden />At risk</li>
      <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-bad-fg" aria-hidden />Empty or critical</li>
      <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] border-2 border-foreground" aria-hidden />Depot</li>
      <li className="flex items-center gap-1.5"><span className="h-0 w-4 border-t-2 border-dashed border-bad-fg" aria-hidden />Disrupted route</li>
      <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border-2 border-foreground bg-foreground" aria-hidden />Truck (ours)</li>
      <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full ring-2 ring-warn-fg" aria-hidden />Demand spike</li>
      <li className="flex items-center gap-1.5"><TankBars fuels={LEGEND_TANKS} />Diesel, petrol, octane</li>
    </ul>
  );
}

// Black-and-white Bangladesh with the live network on top: tanks fill and drain, trucks move along their
// routes each tick, demand spikes glow. Colour is only used for state that needs attention. Each site
// opens a card whose alerts and pending decisions link to where they are handled.
export function NetworkMap({ names }: { names: ReadonlyMap<string, string> }) {
  const network = useNetwork();
  const alerts = useAlerts({ state: "open" });
  const pending = useRecommendations({ status: "PROPOSED", limit: 100 });
  const allocations = useAllocations();
  const overview = useOverview();
  const tick = overview.data?.tick ?? network.data?.tick ?? 0;
  const go = useNavigate();
  const [openId, setOpenId] = useState<string | null>(null);

  const model = useMemo(
    () =>
      network.data
        ? buildMapModel(network.data, alerts.data?.alerts ?? [], pending.data?.recommendations ?? [], allocations.data?.allocations ?? [])
        : undefined,
    [network.data, alerts.data, pending.data, allocations.data],
  );
  const onGo = (target: Target) => {
    setOpenId(null);
    go(target);
  };
  const toggle = (id: string) => (open: boolean) => setOpenId(open ? id : null);

  return (
    <QueryBlock query={network} rows={6}>
      {() =>
        model ? (
          <div className="space-y-3">
            <div className="relative mx-auto w-full max-w-[440px]" style={{ aspectRatio: `${MAP_WIDTH} / ${MAP_HEIGHT}` }}>
              <svg viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} className="absolute inset-0 size-full" role="img" aria-label="Map of Bangladesh with depots, stations and routes">
                {DIVISIONS.map((d) => {
                  const active = [...model.stations, ...model.depots].some((s) => divisionOf(s.regionId) === d.id);
                  return (
                    <path
                      key={d.id}
                      d={d.path}
                      className={active ? "fill-foreground/[0.13]" : "fill-foreground/[0.05]"}
                      stroke="var(--background)"
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
                <path d={COUNTRY_PATH} fill="none" className="stroke-foreground/35" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                {model.routes.map((route) => (
                  <path
                    key={route.route.id}
                    d={routePath(route)}
                    fill="none"
                    className={cn(ROUTE[route.state], route.inTransit.length > 0 && route.state === "ok" && "stroke-foreground/70")}
                    strokeWidth={route.inTransit.length > 0 ? 2 : 1.5}
                    strokeDasharray={route.state === "ok" ? undefined : "4 3"}
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </svg>
              {DIVISIONS.filter((d) => ![...model.stations, ...model.depots].some((s) => divisionOf(s.regionId) === d.id)).map((d) => (
                <span
                  key={d.id}
                  style={pct(d.label.x, d.label.y)}
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 text-[0.625rem] text-muted-foreground/70"
                >
                  {d.name}
                </span>
              ))}
              {model.routes
                .filter((r) => r.state !== "ok")
                .map((route) => (
                  <RouteMarker key={route.route.id} route={route} names={names} open={openId === route.route.id} onOpenChange={toggle(route.route.id)} onGo={onGo} />
                ))}
              {model.routes.flatMap((route) =>
                route.inTransit.map((shipment) => (
                  <ShipmentMarker
                    key={shipment.id}
                    shipment={shipment}
                    route={route}
                    tick={tick}
                    names={names}
                    open={openId === `ship-${shipment.id}`}
                    onOpenChange={toggle(`ship-${shipment.id}`)}
                    onGo={onGo}
                  />
                )),
              )}
              {[...model.depots, ...model.stations].map((site) => (
                <SiteMarker key={site.id} site={site} open={openId === site.id} onOpenChange={toggle(site.id)} onGo={onGo} />
              ))}
            </div>
            <Legend />
            <p className="text-center text-[0.6875rem] text-muted-foreground">
              Sites at approximate real locations. Boundaries: geoBoundaries (public domain).
            </p>
          </div>
        ) : null
      }
    </QueryBlock>
  );
}
