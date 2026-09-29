"use client";

import { FUELS } from "@/components/inventory-table";
import { QueryBlock } from "@/components/query-block";
import { CELL, CELL_NUM, HEAD, HEAD_NUM } from "@/components/table-styles";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDemandRegions } from "@/lib/api/hooks";
import { formatNumber, humanize } from "@/lib/format";

const pct = (v: number | null | undefined) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);

// Regional fuel demand over the last day (96 ticks), with unmet litres and the 12 h forecast.
export function RegionalDemand() {
  const regions = useDemandRegions({ ticks: 96 });
  return (
    <QueryBlock query={regions} rows={4}>
      {(data) => (
        <Table>
          <TableCaption className="sr-only">Demand by region and fuel over the last {data.window_ticks} ticks</TableCaption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={HEAD}>Region</TableHead>
              <TableHead className={HEAD}>Fuel</TableHead>
              <TableHead className={HEAD_NUM}>Demand L</TableHead>
              <TableHead className={HEAD_NUM}>Unmet L</TableHead>
              <TableHead className={HEAD_NUM}>Served</TableHead>
              <TableHead className={HEAD_NUM}>Next 12 h L</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.regions.flatMap((region) => {
              const fuels = FUELS.filter((fuel) => region.fuels[fuel]);
              return fuels.map((fuel, i) => {
                const f = region.fuels[fuel];
                return (
                  <TableRow key={`${region.region_id}:${fuel}`} className={i === fuels.length - 1 ? "" : "border-b-0"}>
                    <TableCell className={`${CELL} font-medium`}>{i === 0 ? region.name : null}</TableCell>
                    <TableCell className={CELL}>
                      {humanize(fuel)}
                      {f.max_demand_multiplier > 1 ? <span className="ml-1.5 text-xs text-warn-fg">demand ×{f.max_demand_multiplier}</span> : null}
                    </TableCell>
                    <TableCell className={CELL_NUM}>{formatNumber(f.demand)}</TableCell>
                    <TableCell className={`${CELL_NUM} ${f.unmet > 0 ? "text-bad-fg" : ""}`}>{formatNumber(f.unmet)}</TableCell>
                    <TableCell className={CELL_NUM}>{pct(f.service_level)}</TableCell>
                    <TableCell className={CELL_NUM}>{formatNumber(f.forecast_next_12h)}</TableCell>
                  </TableRow>
                );
              });
            })}
          </TableBody>
        </Table>
      )}
    </QueryBlock>
  );
}
