"use client";

import { Popover } from "@base-ui/react/popover";
import { ArrowRight } from "@phosphor-icons/react";
import { ICON_SM } from "@/components/icon-props";
import { formatNumber, humanize } from "@/lib/format";
import type { MapRoute } from "@/lib/map/model";
import type { Target } from "@/lib/targets";

const TICK_MINUTES = 15;

export function RouteCard({ route, names, onGo }: { route: MapRoute; names: ReadonlyMap<string, string>; onGo: (target: Target) => void }) {
  const r = route.route;
  const current = r.disruptions.filter((d) => d.status !== "RESOLVED");
  return (
    <div className="space-y-2 text-sm">
      <Popover.Title className="font-medium">
        {names.get(r.source_depot_id) ?? r.source_depot_id} to {names.get(r.destination_station_id) ?? r.destination_station_id}
      </Popover.Title>
      <p className="text-xs text-muted-foreground">
        {r.transit_ticks * TICK_MINUTES} min, up to {formatNumber(r.max_shipment)} L per shipment{r.cross_region ? ", cross-region" : ""}
      </p>
      {current.map((d) => (
        <p key={d.event_id} className={d.status === "ACTIVE" ? "text-bad-fg" : "text-warn-fg"}>
          {d.status === "ACTIVE" ? `Disrupted until tick ${d.end_tick}` : `Disruption planned, ticks ${d.start_tick} to ${d.end_tick}`}
        </p>
      ))}
      {route.inTransit.length > 0 ? (
        <ul className="text-xs">
          {route.inTransit.map((a) => (
            <li key={a.id}>
              {humanize(a.status)}: {formatNumber(a.quantity)} L {humanize(a.fuel_type).toLowerCase()}
              {a.expected_arrival_tick != null ? `, arrives tick ${a.expected_arrival_tick}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        onClick={() => onGo({ tab: "network", section: "routes" })}
        className="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
      >
        Open in Network
        <ArrowRight {...ICON_SM} className="ml-auto transition-transform group-hover:translate-x-0.5" aria-hidden />
      </button>
    </div>
  );
}
