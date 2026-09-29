"use client";

import { ActionError } from "@/components/action-error";
import { EmptyState } from "@/components/section";
import { Button } from "@/components/ui/button";
import { useAccess } from "@/hooks/use-access";
import { useCancelAllocation } from "@/lib/api/hooks";
import { StatusBadge } from "@/components/status-badge";
import { CELL, CELL_NUM, HEAD, HEAD_NUM } from "@/components/table-styles";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Allocation, SimEvent, SupplyArrival } from "@/lib/api/schemas";
import { formatNumber, humanize } from "@/lib/format";
import { statusTone } from "@/lib/tone";

const LIST_LIMIT = 8;

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

export function Events({ events }: { events: SimEvent[] }) {
  const current = events.filter((e) => e.status !== "RESOLVED").slice(0, LIST_LIMIT);
  return (
    <Group title="Disruptions">
      {current.length === 0 ? (
        <EmptyState>No active or scheduled events</EmptyState>
      ) : (
        <ul className="divide-y">
          {current.map((event) => (
            <li key={event.id} className="py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{humanize(event.type)}</span>
                <StatusBadge tone={statusTone(event.status)}>
                  {event.status === "SCHEDULED" ? `in ${event.starts_in_ticks} ticks` : humanize(event.status)}
                </StatusBadge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{event.description}</p>
              {!event.effective ? <p className="text-xs text-warn-fg">No effect: the event names no ids</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Group>
  );
}

export function Allocations({ allocations, names }: { allocations: Allocation[]; names: ReadonlyMap<string, string> }) {
  const latest = [...allocations].sort((a, b) => b.id - a.id).slice(0, LIST_LIMIT);
  const access = useAccess();
  const cancel = useCancelAllocation();
  return (
    <Group title="Shipments">
      {latest.length === 0 ? (
        <EmptyState>No shipments yet</EmptyState>
      ) : (
        <Table>
          <TableCaption className="sr-only">Most recent shipments</TableCaption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={HEAD}>Route</TableHead>
              <TableHead className={HEAD}>Status</TableHead>
              <TableHead className={HEAD_NUM}>L</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {latest.map((a) => (
              <TableRow key={a.id}>
                <TableCell className={CELL}>
                  <div>
                    {names.get(a.source_depot_id) ?? a.source_depot_id} to {names.get(a.destination_station_id) ?? a.destination_station_id}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {humanize(a.fuel_type)}
                    {a.expected_arrival_tick != null ? `, arrives tick ${a.expected_arrival_tick}` : ""}
                    {a.origin === "external" ? ", external" : ""}
                  </div>
                  {a.failure_reason ? <div className="text-xs text-bad-fg">{a.failure_reason}</div> : null}
                </TableCell>
                <TableCell className={CELL}>
                  <StatusBadge tone={statusTone(a.status)}>{humanize(a.status)}</StatusBadge>
                  {a.status === "PENDING" && access.can("cancel") ? (
                    <Button variant="ghost" size="xs" className="ml-1" disabled={cancel.isPending} onClick={() => cancel.mutate(a.id)}>
                      Cancel
                    </Button>
                  ) : null}
                </TableCell>
                <TableCell className={CELL_NUM}>{formatNumber(a.quantity)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ActionError error={cancel.error} />
    </Group>
  );
}

export function IncomingSupply({ arrivals, names }: { arrivals: SupplyArrival[]; names: ReadonlyMap<string, string> }) {
  const upcoming = arrivals
    .filter((s) => s.status !== "ARRIVED")
    .sort((a, b) => a.planned_tick - b.planned_tick)
    .slice(0, LIST_LIMIT);
  return (
    <Group title="Incoming supply">
      {upcoming.length === 0 ? (
        <EmptyState>No supply scheduled</EmptyState>
      ) : (
        <Table>
          <TableCaption className="sr-only">Next scheduled supply arrivals</TableCaption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={HEAD}>Depot</TableHead>
              <TableHead className={HEAD_NUM}>ETA</TableHead>
              <TableHead className={HEAD_NUM}>L</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {upcoming.map((s) => (
              <TableRow key={s.id}>
                <TableCell className={CELL}>
                  <div>{names.get(s.depot_id) ?? s.depot_id}</div>
                  <div className="text-xs text-muted-foreground">{humanize(s.fuel_type)}</div>
                  {s.delay_ticks > 0 || s.shortfall_liters > 0 ? (
                    <div className="text-xs text-warn-fg">
                      {s.delay_ticks > 0 ? `Delayed ${s.delay_ticks} ticks` : ""}
                      {s.delay_ticks > 0 && s.shortfall_liters > 0 ? ", " : ""}
                      {s.shortfall_liters > 0 ? `${formatNumber(s.shortfall_liters)} L short` : ""}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className={CELL_NUM}>{s.eta_ticks != null ? `${s.eta_ticks} ticks` : `tick ${s.planned_tick}`}</TableCell>
                <TableCell className={CELL_NUM}>{formatNumber(s.quantity)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Group>
  );
}
