"use client";

import { QueryBlock } from "@/components/query-block";
import { EmptyState } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { CELL, CELL_NUM, HEAD, HEAD_NUM } from "@/components/table-styles";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCommands } from "@/lib/api/hooks";
import { formatClock, humanize } from "@/lib/format";

const TONE = { DONE: "ok", PENDING: "warn", FAILED: "bad" } as const;

function describe(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  if (typeof p.count === "number") return `${p.count} tick${p.count === 1 ? "" : "s"}`;
  if (typeof p.type === "string") return humanize(p.type);
  return "";
}

export function CommandLog({ enabled }: { enabled: boolean }) {
  const commands = useCommands(enabled);
  if (!enabled) return <EmptyState>Admin access needed to see the command log</EmptyState>;
  return (
    <QueryBlock query={commands}>
      {(data) =>
        data.commands.length === 0 ? (
          <EmptyState>No commands yet</EmptyState>
        ) : (
          <Table>
            <TableCaption className="sr-only">Simulator commands, newest first</TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={HEAD}>Command</TableHead>
                <TableHead className={HEAD}>Status</TableHead>
                <TableHead className={HEAD}>By</TableHead>
                <TableHead className={HEAD_NUM}>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.commands.slice(0, 12).map((c) => (
                <TableRow key={c.id}>
                  <TableCell className={`${CELL} whitespace-normal`}>
                    <span className="font-medium">{humanize(c.kind)}</span>
                    <span className="text-muted-foreground"> {describe(c.payload)}</span>
                    {c.error ? <div className="text-xs text-bad-fg">{c.error}</div> : null}
                  </TableCell>
                  <TableCell className={CELL}>
                    <StatusBadge tone={TONE[c.status]}>{humanize(c.status)}</StatusBadge>
                  </TableCell>
                  <TableCell className={`${CELL} text-muted-foreground`}>{c.requested_by}</TableCell>
                  <TableCell className={CELL_NUM}>{formatClock(Date.parse(c.created_at))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      }
    </QueryBlock>
  );
}
