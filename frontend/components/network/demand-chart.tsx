"use client";

import { useMemo, useState } from "react";
import { FIELD, LABEL } from "@/components/form-styles";
import { FUELS } from "@/components/inventory-table";
import { EmptyState } from "@/components/section";
import { Skeleton } from "@/components/ui/skeleton";
import { useDemand } from "@/lib/api/hooks";
import type { Fuel, NetworkStation } from "@/lib/api/schemas";
import { demandPoints, niceMax, ticksBetween, type DemandPoint } from "@/lib/chart";
import { formatNumber, humanize } from "@/lib/format";

const W = 640;
const H = 220;
const M = { top: 12, right: 72, bottom: 24, left: 48 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

function path(points: DemandPoint[], key: "observed" | "forecast", x: (t: number) => number, y: (v: number) => number): string {
  return points
    .filter((p) => p[key] !== undefined)
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.tick).toFixed(1)},${y(p[key] as number).toFixed(1)}`)
    .join("");
}

function band(points: DemandPoint[], x: (t: number) => number, y: (v: number) => number): string {
  const future = points.filter((p) => p.low !== undefined && p.high !== undefined);
  if (future.length < 2) return "";
  const top = future.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.tick).toFixed(1)},${y(p.high as number).toFixed(1)}`).join("");
  const bottom = [...future].reverse().map((p) => `L${x(p.tick).toFixed(1)},${y(p.low as number).toFixed(1)}`).join("");
  return `${top}${bottom}Z`;
}

function Chart({ points, now }: { points: DemandPoint[]; now: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const first = points[0].tick;
  const last = points[points.length - 1].tick;
  const max = niceMax(Math.max(...points.map((p) => Math.max(p.observed ?? 0, p.forecast ?? 0, p.high ?? 0))));
  const x = (t: number) => M.left + ((t - first) / Math.max(1, last - first)) * PLOT_W;
  const y = (v: number) => M.top + PLOT_H - (v / max) * PLOT_H;
  const lastObserved = [...points].reverse().find((p) => p.observed !== undefined);
  const lastForecast = [...points].reverse().find((p) => p.forecast !== undefined);
  const active = hover === null ? undefined : points[hover];

  function onMove(event: React.PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const tick = first + ((event.clientX - box.left) / box.width) * (last - first);
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(p.tick - tick) < Math.abs(points[best].tick - tick)) best = i;
    });
    setHover(best);
  }

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Observed demand and forecast, litres per tick">
        {ticksBetween(max, 4).map((v) => (
          <g key={v}>
            <line x1={M.left} x2={M.left + PLOT_W} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} />
            <text x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground font-mono text-[10px] tabular-nums">
              {formatNumber(v)}
            </text>
          </g>
        ))}
        {[first, now, last].map((t) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor="middle" className="fill-muted-foreground font-mono text-[10px]">
            {t === now ? "now" : `t${t}`}
          </text>
        ))}
        <line x1={x(now)} x2={x(now)} y1={M.top} y2={M.top + PLOT_H} className="stroke-muted-foreground/40" strokeWidth={1} />
        <path d={band(points, x, y)} className="fill-series-2" fillOpacity={0.12} />
        <path d={path(points, "forecast", x, y)} className="stroke-series-2" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <path d={path(points, "observed", x, y)} className="stroke-series-1" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {lastObserved ? (
          <text x={x(lastObserved.tick) + 6} y={y(lastObserved.observed as number)} dy="0.32em" className="fill-foreground text-[10px]">
            Observed
          </text>
        ) : null}
        {lastForecast ? (
          <text x={x(lastForecast.tick) + 6} y={y(lastForecast.forecast as number)} dy="0.32em" className="fill-foreground text-[10px]">
            Forecast
          </text>
        ) : null}
        {active ? (
          <g>
            <line x1={x(active.tick)} x2={x(active.tick)} y1={M.top} y2={M.top + PLOT_H} className="stroke-foreground/30" strokeWidth={1} />
            {active.observed !== undefined ? (
              <circle cx={x(active.tick)} cy={y(active.observed)} r={4} className="fill-series-1 stroke-background" strokeWidth={2} />
            ) : null}
            {active.forecast !== undefined ? (
              <circle cx={x(active.tick)} cy={y(active.forecast)} r={4} className="fill-series-2 stroke-background" strokeWidth={2} />
            ) : null}
          </g>
        ) : null}
        <rect
          x={M.left}
          y={M.top}
          width={PLOT_W}
          height={PLOT_H}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {active ? (
        <div
          className="pointer-events-none absolute top-2 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-sm"
          style={{ left: `${(x(active.tick) / W) * 100}%`, transform: x(active.tick) > W / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
        >
          <p className="font-medium">Tick {active.tick}</p>
          {active.observed !== undefined ? <p>Observed {formatNumber(active.observed)} L</p> : null}
          {active.forecast !== undefined ? <p>Forecast {formatNumber(active.forecast)} L</p> : null}
          {active.low !== undefined ? (
            <p className="text-muted-foreground">
              Range {formatNumber(active.low)} to {formatNumber(active.high)} L
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Demand vs forecast for one station and fuel: history against what had been forecast for it, then
// the forecast ahead with its noise band (docs/API.md 5.5).
export function DemandChart({ stations, now }: { stations: NetworkStation[]; now: number }) {
  const [stationId, setStationId] = useState("");
  const [fuel, setFuel] = useState<Fuel>("PETROL");
  const station = stationId || stations[0]?.id || "";
  const demand = useDemand({ station_id: station, fuel_type: fuel, ticks: 48, horizon: 24 });
  const series = demand.data?.series[0];
  const points = useMemo(() => (series ? demandPoints(series) : []), [series]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="w-56">
          <span className={LABEL}>Station</span>
          <select className={FIELD} value={station} onChange={(e) => setStationId(e.target.value)}>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="w-36">
          <span className={LABEL}>Fuel</span>
          <select className={FIELD} value={fuel} onChange={(e) => setFuel(e.target.value as Fuel)}>
            {FUELS.map((f) => (
              <option key={f} value={f}>
                {humanize(f)}
              </option>
            ))}
          </select>
        </label>
        <ul className="ml-auto flex gap-4 text-xs text-muted-foreground" aria-label="Legend">
          <li className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full bg-series-1" aria-hidden />
            Observed demand
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full bg-series-2" aria-hidden />
            Forecast, with range
          </li>
        </ul>
      </div>
      {demand.isPending ? (
        <Skeleton className="aspect-[640/220] w-full motion-reduce:animate-none" />
      ) : points.length < 2 ? (
        <EmptyState>No demand history yet</EmptyState>
      ) : (
        <>
          <Chart points={points} now={now} />
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground">Show as table</summary>
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-1 text-left font-normal">Tick</th>
                  <th className="py-1 text-right font-normal">Observed L</th>
                  <th className="py-1 text-right font-normal">Forecast L</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {points.map((p) => (
                  <tr key={p.tick} className="border-t">
                    <td className="py-1">{p.tick}</td>
                    <td className="py-1 text-right">{p.observed === undefined ? "" : formatNumber(p.observed)}</td>
                    <td className="py-1 text-right">{p.forecast === undefined ? "" : formatNumber(p.forecast)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </div>
  );
}
