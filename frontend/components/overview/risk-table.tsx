"use client";

import { useState } from "react";
import { QueryBlock } from "@/components/query-block";
import { EmptyState } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { CELL, CELL_NUM, HEAD, HEAD_NUM } from "@/components/table-styles";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRisk } from "@/lib/api/hooks";
import type { RiskSeries } from "@/lib/api/schemas";
import { formatNumber, formatProbability, humanize, stockoutLabel } from "@/lib/format";
import { groupBy } from "@/lib/group";
import { RISK_TONE } from "@/lib/tone";

const COLLAPSED = 8;

// Projected shortage risk (brief section 6). The API orders series by urgency; rows are grouped by
// station (in that order) so each station is named once.
export function RiskTable() {
  const risk = useRisk();
  const [expanded, setExpanded] = useState(false);
  return (
    <QueryBlock query={risk} rows={4}>
      {(data) => {
        const atRisk = data.series.filter((s) => s.risk_level !== "normal");
        if (atRisk.length === 0) return <EmptyState>No station is projected to run out in the next 12 hours</EmptyState>;
        const shown = expanded ? atRisk : atRisk.slice(0, COLLAPSED);
        return (
          <div className="space-y-3">
            <Table>
              <TableCaption className="sr-only">{data.method}</TableCaption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className={HEAD}>Station</TableHead>
                  <TableHead className={HEAD}>Fuel</TableHead>
                  <TableHead className={HEAD}>Risk</TableHead>
                  <TableHead className={HEAD_NUM}>Stockout</TableHead>
                  <TableHead className={HEAD_NUM}>Probability</TableHead>
                  <TableHead className={HEAD_NUM}>
                    Stock <span className="opacity-60">/ 12 h demand</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groupBy(shown, (s) => s.station_id).flatMap(({ items }) =>
                  items.map((s: RiskSeries, i) => {
                    const stock = s.on_hand + s.in_transit;
                    const label = stockoutLabel(s.time_to_stockout_hours, s.on_hand);
                    return (
                      <TableRow key={`${s.station_id}:${s.fuel_type}`} className={i === items.length - 1 ? "" : "border-b-0"}>
                        <TableCell className={`${CELL} font-medium`}>{i === 0 ? s.station_name : null}</TableCell>
                        <TableCell className={CELL}>{humanize(s.fuel_type)}</TableCell>
                        <TableCell className={CELL}>
                          <StatusBadge tone={RISK_TONE[s.risk_level]}>{s.risk_level}</StatusBadge>
                        </TableCell>
                        <TableCell className={`${CELL_NUM} ${label === "Empty" ? "font-sans font-medium text-bad-fg" : ""}`}>{label}</TableCell>
                        <TableCell className={CELL_NUM}>{formatProbability(s.stockout_prob)}</TableCell>
                        <TableCell className={CELL_NUM}>
                          {formatNumber(stock)} <span className="text-muted-foreground">/ {formatNumber(s.demand_next_12h)}</span>
                        </TableCell>
                      </TableRow>
                    );
                  }),
                )}
              </TableBody>
            </Table>
            {atRisk.length > COLLAPSED ? (
              <Button variant="ghost" size="xs" onClick={() => setExpanded((v) => !v)}>
                {expanded ? "Show fewer" : `Show all ${atRisk.length}`}
              </Button>
            ) : null}
          </div>
        );
      }}
    </QueryBlock>
  );
}
