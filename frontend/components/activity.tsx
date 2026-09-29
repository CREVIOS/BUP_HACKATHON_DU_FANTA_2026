"use client";

import { ActionError } from "@/components/action-error";
import { EmptyState } from "@/components/section";
import { Button } from "@/components/ui/button";
import { useAccess } from "@/hooks/use-access";
import { useCancelAllocation } from "@/lib/api/hooks";
import { StatusBadge } from "@/components/status-badge";
import type { Allocation, SimEvent, SupplyArrival } from "@/lib/api/schemas";
import { formatNumber, humanize } from "@/lib/format";
import { statusTone } from "@/lib/tone";

const LIST_LIMIT = 8;

// One line of activity: what (wraps freely, so a narrow column never scrolls sideways) and, on the
// right, its state and amount.
function Item({ title, detail, aside, children }: { title: React.ReactNode; detail: React.ReactNode; aside: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
        {children}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-right">{aside}</div>
    </li>
  );
}

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
        <ul className="divide-y" aria-label="Most recent shipments">
          {latest.map((a) => (
            <Item
              key={a.id}
              title={`${names.get(a.source_depot_id) ?? a.source_depot_id} → ${names.get(a.destination_station_id) ?? a.destination_station_id}`}
              detail={
                <>
                  <span className="tabular-nums">{formatNumber(a.quantity)} L</span> {humanize(a.fuel_type).toLowerCase()}
                  {a.expected_arrival_tick != null ? `, arrives tick ${a.expected_arrival_tick}` : ""}
                  {a.origin === "external" ? ", external" : ""}
                </>
              }
              aside={
                <>
                  <StatusBadge tone={statusTone(a.status)}>{humanize(a.status)}</StatusBadge>
                  {a.status === "PENDING" && access.can("cancel") ? (
                    <Button variant="ghost" size="xs" disabled={cancel.isPending} onClick={() => cancel.mutate(a.id)}>
                      Cancel
                    </Button>
                  ) : null}
                </>
              }
            >
              {a.failure_reason ? <p className="text-xs text-bad-fg">{a.failure_reason}</p> : null}
            </Item>
          ))}
        </ul>
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
        <ul className="divide-y" aria-label="Next scheduled supply arrivals">
          {upcoming.map((s) => (
            <Item
              key={s.id}
              title={names.get(s.depot_id) ?? s.depot_id}
              detail={humanize(s.fuel_type)}
              aside={
                <>
                  <span className="text-sm tabular-nums">{formatNumber(s.quantity)} L</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{s.eta_ticks != null ? `in ${s.eta_ticks} ticks` : `tick ${s.planned_tick}`}</span>
                </>
              }
            >
              {s.delay_ticks > 0 || s.shortfall_liters > 0 ? (
                <p className="text-xs text-warn-fg">
                  {s.delay_ticks > 0 ? `Delayed ${s.delay_ticks} ticks` : ""}
                  {s.delay_ticks > 0 && s.shortfall_liters > 0 ? ", " : ""}
                  {s.shortfall_liters > 0 ? `${formatNumber(s.shortfall_liters)} L short` : ""}
                </p>
              ) : null}
            </Item>
          ))}
        </ul>
      )}
    </Group>
  );
}
