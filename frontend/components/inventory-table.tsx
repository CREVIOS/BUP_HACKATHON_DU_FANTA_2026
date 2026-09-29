import { StatusBadge } from "@/components/status-badge";
import { CELL, HEAD, HEAD_NUM } from "@/components/table-styles";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Fuel, RiskLevel } from "@/lib/api/schemas";
import { formatNumber, formatPercent, humanize, stockLevel } from "@/lib/format";
import { statusTone } from "@/lib/tone";

export const FUELS: readonly Fuel[] = ["DIESEL", "PETROL", "OCTANE"];

export interface FuelCellData {
  inventory: number;
  capacity: number;
  fill: number; // 0..1
  risk?: RiskLevel; // stations: the backend's projected stockout risk
  hoursToStockout?: number | null;
}

export interface InventoryRow {
  id: string;
  name: string;
  region: string;
  status: string;
  fuels: Partial<Record<Fuel, FuelCellData>>;
}

type Level = "bad" | "warn" | "ok";
const BAR: Record<Level, string> = { bad: "bg-bad-fg", warn: "bg-warn-fg", ok: "bg-foreground/35" };
const TEXT: Record<Level, string> = { bad: "text-bad-fg", warn: "text-warn-fg", ok: "text-muted-foreground" };

// Stations are judged by projected risk (time to stockout), depots by fill.
function levelOf(cell: FuelCellData): Level {
  if (cell.risk) return cell.risk === "critical" || cell.risk === "high" ? "bad" : cell.risk === "elevated" ? "warn" : "ok";
  const fill = stockLevel(cell.fill);
  return fill === "low" ? "bad" : fill === "watch" ? "warn" : "ok";
}

function FuelCell({ cell }: { cell?: FuelCellData }) {
  if (!cell) return <TableCell className={`${CELL} text-right text-muted-foreground`}>n/a</TableCell>;
  const level = levelOf(cell);
  const width = Math.min(100, Math.max(0, cell.fill * 100));
  const hours = cell.hoursToStockout;
  return (
    <TableCell className={`${CELL} text-right`} title={`${formatNumber(cell.inventory)} L of ${formatNumber(cell.capacity)} L`}>
      <div className="ml-auto w-28">
        <div className="flex items-baseline justify-between font-mono text-sm tabular-nums">
          <span className={`text-xs ${TEXT[level]}`}>
            {typeof hours === "number" ? `${hours.toFixed(1)} h` : formatPercent(cell.fill)}
          </span>
          <span>{formatNumber(cell.inventory)}</span>
        </div>
        <div className="mt-1 h-1 rounded-full bg-muted" aria-hidden>
          <div className={`h-full rounded-full ${BAR[level]}`} style={{ width: `${width}%` }} />
        </div>
      </div>
    </TableCell>
  );
}

export function InventoryTable({ label, rows, note }: { label: string; rows: InventoryRow[]; note?: string }) {
  return (
    <Table>
      <TableCaption className="sr-only">
        {label} inventory in litres by fuel{note ? `. ${note}` : ""}
      </TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={HEAD}>{label}</TableHead>
          {FUELS.map((fuel) => (
            <TableHead key={fuel} className={HEAD_NUM}>
              {humanize(fuel)} <span className="opacity-60">L</span>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className={CELL}>
              <div className="flex items-center gap-2">
                <span className="font-medium">{row.name}</span>
                {row.status !== "OPEN" ? <StatusBadge tone={statusTone(row.status)}>{humanize(row.status)}</StatusBadge> : null}
              </div>
              <div className="text-xs text-muted-foreground">{row.region}</div>
            </TableCell>
            {FUELS.map((fuel) => (
              <FuelCell key={fuel} cell={row.fuels[fuel]} />
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
