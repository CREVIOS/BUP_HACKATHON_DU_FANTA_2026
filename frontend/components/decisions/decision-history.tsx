"use client";

import { QueryBlock } from "@/components/query-block";
import { EmptyState } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { CELL, CELL_NUM, HEAD, HEAD_NUM } from "@/components/table-styles";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDecisions } from "@/lib/api/hooks";
import { formatClock, formatNumber, humanize } from "@/lib/format";
import type { Tone } from "@/lib/tone";

const ACTION_TONE: Record<string, Tone> = { APPROVE: "ok", AUTO_EXECUTE: "info", REJECT: "neutral" };

// Audit trail across epochs (brief section 6: decision history).
export function DecisionHistory({ names }: { names: ReadonlyMap<string, string> }) {
  const decisions = useDecisions(30);
  return (
    <QueryBlock query={decisions}>
      {(data) =>
        data.decisions.length === 0 ? (
          <EmptyState>No decisions yet</EmptyState>
        ) : (
          <Table>
            <TableCaption className="sr-only">Decision history, newest first</TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={HEAD}>Decision</TableHead>
                <TableHead className={HEAD}>Shipment</TableHead>
                <TableHead className={HEAD}>Outcome</TableHead>
                <TableHead className={HEAD_NUM}>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.decisions.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className={CELL}>
                    <StatusBadge tone={ACTION_TONE[d.action] ?? "neutral"}>{humanize(d.action)}</StatusBadge>
                    <div className="mt-1 text-xs text-muted-foreground">{d.actor}</div>
                  </TableCell>
                  <TableCell className={`${CELL} whitespace-normal`}>
                    <div>
                      {formatNumber(d.recommendation.quantity)} L {humanize(d.recommendation.fuel_type).toLowerCase()} to{" "}
                      {names.get(d.recommendation.station_id) ?? d.recommendation.station_id}
                    </div>
                    {d.reason ? <div className="text-xs text-muted-foreground">{d.reason}</div> : null}
                  </TableCell>
                  <TableCell className={`${CELL} whitespace-normal text-sm`}>
                    {d.outcome.error ? (
                      <span className="text-bad-fg">{d.outcome.error}</span>
                    ) : d.outcome.sim_status ? (
                      humanize(d.outcome.sim_status)
                    ) : d.outcome.submission ? (
                      humanize(d.outcome.submission)
                    ) : (
                      <span className="text-muted-foreground">Not sent</span>
                    )}
                  </TableCell>
                  <TableCell className={CELL_NUM}>{formatClock(Date.parse(d.created_at))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      }
    </QueryBlock>
  );
}
