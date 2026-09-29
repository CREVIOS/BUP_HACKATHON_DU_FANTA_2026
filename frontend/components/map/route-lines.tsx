"use client";

import { formatNumber } from "@/lib/format";
import { routeCurve, type MapRoute } from "@/lib/map/model";
import { cn } from "@/lib/utils";

const STROKE: Record<MapRoute["state"], string> = {
  ok: "stroke-foreground/30",
  scheduled: "stroke-warn-fg",
  disrupted: "stroke-bad-fg",
};

function routePath(route: MapRoute): string {
  const { from, control, to } = routeCurve(route);
  return `M${from.x},${from.y} Q${control.x},${control.y} ${to.x},${to.y}`;
}

// Is this route part of what the pointer (or an open card) is on: one of its two sites, the route
// itself, or a truck on it?
export function touches(route: MapRoute, focus: string | null): boolean {
  if (focus === null) return false;
  const { id, source_depot_id, destination_station_id } = route.route;
  return focus === id || focus === source_depot_id || focus === destination_station_id || route.inTransit.some((a) => `ship-${a.id}` === focus);
}

function describe(route: MapRoute, names: ReadonlyMap<string, string>, tickMinutes: number): string {
  const r = route.route;
  const state = route.state === "disrupted" ? ", disrupted" : route.state === "scheduled" ? ", disruption planned" : "";
  const trucks = route.inTransit.length > 0 ? `, ${route.inTransit.length} ${route.inTransit.length === 1 ? "truck" : "trucks"} on it` : "";
  return `${names.get(r.source_depot_id) ?? r.source_depot_id} → ${names.get(r.destination_station_id) ?? r.destination_station_id}: ${r.transit_ticks * tickMinutes} min, up to ${formatNumber(r.max_shipment)} L${state}${trucks}`;
}

// The network's edges. Routes with a truck on them flow from depot to station; the routes touching what
// the pointer is on light up and the rest fade, so a site's connections read at a glance.
export function RouteLines({
  routes,
  focus,
  names,
  tickMinutes,
  onHover,
}: {
  routes: MapRoute[];
  focus: string | null;
  names: ReadonlyMap<string, string>;
  tickMinutes: number;
  onHover: (id: string | null) => void;
}) {
  return (
    <g>
      {routes.map((route) => {
        const d = routePath(route);
        const lit = touches(route, focus);
        const busy = route.inTransit.length > 0;
        const width = lit ? 3 : busy ? 2 : 1.5;
        return (
          <g key={route.route.id} className={cn("transition-opacity duration-200 motion-reduce:transition-none", focus !== null && !lit && "opacity-20")}>
            <path
              d={d}
              fill="none"
              className={cn(STROKE[route.state], route.state === "ok" && lit && "stroke-foreground", "transition-[stroke-width] duration-200 motion-reduce:transition-none")}
              style={{ strokeWidth: width }}
              strokeDasharray={route.state === "ok" ? undefined : "4 3"}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {busy && route.state !== "disrupted" ? (
              <path d={d} fill="none" className="live-flow stroke-foreground" style={{ strokeWidth: width }} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            ) : null}
            {/* a wide invisible stroke so the thin line is easy to point at */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={14}
              pointerEvents="stroke"
              vectorEffect="non-scaling-stroke"
              onPointerEnter={() => onHover(route.route.id)}
              onPointerLeave={() => onHover(null)}
            >
              <title>{describe(route, names, tickMinutes)}</title>
            </path>
          </g>
        );
      })}
    </g>
  );
}
