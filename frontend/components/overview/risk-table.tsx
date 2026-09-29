"use client";

import { QueryBlock } from "@/components/query-block";
import { EmptyState } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { CELL, CELL_NUM, HEAD, HEAD_NUM } from "@/components/table-styles";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRisk } from "@/lib/api/hooks";
import { formatHours, formatNumber, formatProbability, humanize } from "@/lib/format";
import { RISK_TONE } from "@/lib/tone";

const LIMIT = 8;

// Projected shortage risk (brief section 6), most urgent first as the API orders it.
export function RiskTable() {
  const risk = useRisk();
  return (
    <QueryBlock query={risk} rows={4}>
      {(data) => {
        const atRisk = data.series.filter((s) => s.risk_level !== "normal").slice(0, LIMIT);
        if (atRisk.length === 0) return <EmptyState>No station is projected to run out in the next 12 hours</EmptyState>;
        return (
          <Table>
            <TableCaption className="sr-only">{data.method}</TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={HEAD}>Station</TableHead>
                <TableHead className={HEAD}>Risk</TableHead>
                <TableHead className={HEAD_NUM}>Stockout in</TableHead>
                <TableHead className={HEAD_NUM}>Probability</TableHead>
                <TableHead className={HEAD_NUM}>
                  Stock <span className="opacity-60">/ 12 h demand</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {atRisk.map((s) => (
                <TableRow key={`${s.station_id}:${s.fuel_type}`}>
                  <TableCell className={CELL}>
                    <div className="font-medium">{s.station_name}</div>
                    <div className="text-xs text-muted-foreground">{humanize(s.fuel_type)}</div>
                  </TableCell>
                  <TableCell className={CELL}>
                    <StatusBadge tone={RISK_TONE[s.risk_level]}>{s.risk_level}</StatusBadge>
                  </TableCell>
                  <TableCell className={CELL_NUM}>{formatHours(s.time_to_stockout_hours)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatProbability(s.stockout_prob)}</TableCell>
                  <TableCell className={CELL_NUM}>
                    {formatNumber(s.on_hand + s.in_transit)} <span className="text-muted-foreground">/ {formatNumber(s.demand_next_12h)}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        );
      }}
    </QueryBlock>
  );
}
