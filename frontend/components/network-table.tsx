import { ArrowRight, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { ICON, ICON_SM } from "@/components/icon-props";
import { CELL, CELL_NUM, HEAD, HEAD_NUM } from "@/components/table-styles";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { NetworkRoute } from "@/lib/api/schemas";
import { formatNumber } from "@/lib/format";

function disruptionNote(route: NetworkRoute): string | undefined {
  const next = route.disruptions.find((d) => d.status !== "RESOLVED");
  if (!next) return undefined;
  return next.status === "ACTIVE" ? `Disrupted until tick ${next.end_tick}` : `Disruption ticks ${next.start_tick} to ${next.end_tick}`;
}

export function NetworkTable({ routes, names, tickMinutes }: { routes: NetworkRoute[]; names: ReadonlyMap<string, string>; tickMinutes: number }) {
  return (
    <Table>
      <TableCaption className="sr-only">Transport routes from depots to stations</TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={HEAD}>Route</TableHead>
          <TableHead className={HEAD_NUM}>Transit</TableHead>
          <TableHead className={HEAD_NUM}>
            Max <span className="opacity-60">L</span>
          </TableHead>
          <TableHead className={`${HEAD_NUM} w-10`}>
            <span className="sr-only">Usable now</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {routes.map((route) => {
          const note = disruptionNote(route);
          return (
            <TableRow key={route.id}>
              <TableCell className={CELL}>
                <span className={`inline-flex flex-wrap items-center gap-x-2 ${route.usable_now ? "" : "text-bad-fg"}`}>
                  <span className="font-medium">{names.get(route.source_depot_id) ?? route.source_depot_id}</span>
                  <ArrowRight {...ICON_SM} className="text-muted-foreground" role="img" aria-label="to" />
                  <span>{names.get(route.destination_station_id) ?? route.destination_station_id}</span>
                  {route.cross_region ? <span className="text-xs text-muted-foreground">cross-region</span> : null}
                </span>
                {note ? <div className="text-xs text-warn-fg">{note}</div> : null}
              </TableCell>
              <TableCell className={CELL_NUM} title={`${route.transit_ticks} ticks`}>
                {route.transit_ticks * tickMinutes} min
              </TableCell>
              <TableCell className={CELL_NUM}>{formatNumber(route.max_shipment)}</TableCell>
              <TableCell className={`${CELL} text-right`}>
                {route.usable_now ? (
                  <CheckCircle {...ICON} weight="fill" className="ml-auto text-ok-fg" role="img" aria-label="Usable now" />
                ) : (
                  <WarningCircle {...ICON} weight="fill" className="ml-auto text-bad-fg" role="img" aria-label="Not usable now" />
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
