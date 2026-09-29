"use client";

import { useMemo, useState } from "react";
import { RouteMarker, ShipmentMarker, SiteMarker, TankBars, pct } from "@/components/map/markers";
import { RouteLines, touches } from "@/components/map/route-lines";
import { useNavigate } from "@/components/navigation";
import { QueryBlock } from "@/components/query-block";
import { useAlerts, useAllocations, useNetwork, useOverview, useRecommendations } from "@/lib/api/hooks";
import { COUNTRY_PATH, DIVISIONS, MAP_HEIGHT, MAP_WIDTH } from "@/lib/map/bangladesh";
import { buildMapModel, type MapFuel, type MapModel } from "@/lib/map/model";
import { divisionOf } from "@/lib/map/sites";
import type { Target } from "@/lib/targets";

// The sites at either end of every route touching the focus (plus the focus itself); null when nothing is focused.
function litSites(model: MapModel, focus: string | null): ReadonlySet<string> | null {
  if (focus === null) return null;
  const lit = new Set([focus]);
  for (const route of model.routes) {
    if (!touches(route, focus)) continue;
    lit.add(route.route.source_depot_id);
    lit.add(route.route.destination_station_id);
  }
  return lit;
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
// routes each tick, demand spikes glow, and pointing at anything traces its routes. Colour is only used for
// state that needs attention. Each site opens a card whose alerts and pending decisions link to where they
// are handled.
export function NetworkMap({ names }: { names: ReadonlyMap<string, string> }) {
  const network = useNetwork();
  const alerts = useAlerts({ state: "open" });
  const pending = useRecommendations({ status: "PROPOSED", limit: 100 });
  const allocations = useAllocations();
  const overview = useOverview();
  const tick = overview.data?.tick ?? network.data?.tick ?? 0;
  const go = useNavigate();
  const [openId, setOpenId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const focus = hoverId ?? openId; // what the pointer is on, else the open card

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
  const hover = (id: string) => (on: boolean) => setHoverId((current) => (on ? id : current === id ? null : current));
  const lit = model ? litSites(model, focus) : null;
  const marker = (id: string, dimmed: boolean) => ({ open: openId === id, onOpenChange: toggle(id), onGo, onHover: hover(id), dimmed });

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
                <RouteLines routes={model.routes} focus={focus} names={names} tickMinutes={overview.data?.tick_minutes ?? 15} onHover={setHoverId} />
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
                  <RouteMarker key={route.route.id} route={route} names={names} {...marker(route.route.id, focus !== null && !touches(route, focus))} />
                ))}
              {model.routes.flatMap((route) =>
                route.inTransit.map((shipment) => (
                  <ShipmentMarker
                    key={shipment.id}
                    shipment={shipment}
                    route={route}
                    tick={tick}
                    names={names}
                    {...marker(`ship-${shipment.id}`, focus !== null && !touches(route, focus))}
                  />
                )),
              )}
              {[...model.depots, ...model.stations].map((site) => (
                <SiteMarker key={site.id} site={site} {...marker(site.id, lit !== null && !lit.has(site.id))} />
              ))}
            </div>
            <Legend />
            <p className="text-center text-[0.6875rem] text-muted-foreground">
              Point at a site, truck or route to trace its connections. Sites at approximate real locations. Boundaries: geoBoundaries (public domain).
            </p>
          </div>
        ) : null
      }
    </QueryBlock>
  );
}
