"use client";

import { useAllocations, useNetwork, useOverview } from "@/lib/api/hooks";
import type { Allocation, NetworkDepot, NetworkRoute, NetworkStation, RiskLevel } from "@/lib/api/schemas";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

// Fixed layout of the published network: Dhaka on the left, Chattogram on the right. Straight routes keep the
// truck arithmetic exact; the two cross-region routes pass between the stations.
const POS: Record<string, [number, number]> = {
  "depot-gazipur": [95, 190],
  "station-mirpur": [270, 78],
  "station-tongi": [270, 302],
  "station-karnaphuli": [450, 78],
  "station-coxsbazar": [450, 302],
  "depot-patiya": [625, 190],
};
const W = 720;
const H = 380;
const FUELS = ["DIESEL", "PETROL", "OCTANE"] as const;
const RISK_FILL: Record<RiskLevel, string> = {
  normal: "var(--chart-4)",
  elevated: "var(--warn-fg)",
  high: "var(--bad-fg)",
  critical: "var(--bad-fg)",
};

function at(route: NetworkRoute, t: number): [number, number] | null {
  const a = POS[route.source_depot_id];
  const b = POS[route.destination_station_id];
  if (!a || !b) return null;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// How far along its route a shipment is: 0 while PENDING at the depot, then departure -> arrival.
function progress(a: Allocation, tick: number): number {
  if (a.status === "PENDING" || a.departure_tick == null || a.expected_arrival_tick == null) return 0;
  const span = Math.max(a.expected_arrival_tick - a.departure_tick, 1);
  return Math.min(Math.max((tick - a.departure_tick) / span, 0), 1);
}

function Bars({ fuels, x, y, risk }: { fuels: Record<string, { fill: number; risk_level?: RiskLevel }>; x: number; y: number; risk: boolean }) {
  return (
    <g>
      {FUELS.map((f, i) => {
        const fuel = fuels[f];
        const fill = Math.min(Math.max(fuel?.fill ?? 0, 0), 1);
        const bx = x + i * 18;
        const colour = risk && fuel?.risk_level ? RISK_FILL[fuel.risk_level] : "var(--chart-4)";
        return (
          <g key={f}>
            <rect x={bx} y={y} width={12} height={34} rx={2} fill="var(--muted)" />
            <rect
              x={bx}
              y={y + 34 * (1 - fill)}
              width={12}
              height={34 * fill}
              rx={2}
              fill={colour}
              style={{ transition: "y 700ms ease, height 700ms ease, fill 400ms" }}
            >
              <title>{`${f}: ${Math.round(fill * 100)}% full${fuel?.risk_level ? `, ${fuel.risk_level} risk` : ""}`}</title>
            </rect>
            <text x={bx + 6} y={y + 46} textAnchor="middle" className="fill-muted-foreground" fontSize={9}>
              {f[0]}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function StationNode({ s }: { s: NetworkStation }) {
  const p = POS[s.id];
  if (!p) return null;
  const [cx, cy] = p;
  const spike = s.demand_multiplier > 1.001;
  const outage = s.status !== "OPEN";
  return (
    <g opacity={outage ? 0.45 : 1}>
      {spike ? <rect x={cx - 66} y={cy - 44} width={132} height={88} rx={12} fill="none" stroke="var(--warn-fg)" strokeWidth={2} className="live-glow" /> : null}
      <rect x={cx - 60} y={cy - 38} width={120} height={76} rx={8} fill="var(--card)" stroke="var(--border)" />
      <text x={cx} y={cy - 22} textAnchor="middle" fontSize={11} fontWeight={500} className="fill-foreground">
        {s.name.replace(/ (Fuel|Industrial|Highway|Regional) Station$/, "")}
      </text>
      <Bars fuels={s.fuels} x={cx - 24} y={cy - 14} risk />
      {spike ? (
        <text x={cx} y={cy + 56} textAnchor="middle" fontSize={10} fill="var(--warn-fg)">
          demand ×{s.demand_multiplier.toFixed(2)}
        </text>
      ) : null}
      {outage ? (
        <text x={cx} y={cy + 56} textAnchor="middle" fontSize={10} fill="var(--bad-fg)">
          {s.status}
        </text>
      ) : null}
    </g>
  );
}

function DepotNode({ d }: { d: NetworkDepot }) {
  const p = POS[d.id];
  if (!p) return null;
  const [cx, cy] = p;
  return (
    <g>
      <rect x={cx - 62} y={cy - 40} width={124} height={80} rx={8} fill="var(--muted)" stroke="var(--chart-2)" />
      <text x={cx} y={cy - 24} textAnchor="middle" fontSize={11} fontWeight={600} className="fill-foreground">
        {d.name}
      </text>
      <Bars fuels={d.fuels} x={cx - 24} y={cy - 14} risk={false} />
      <text x={cx} y={cy + 54} textAnchor="middle" fontSize={9} className="fill-muted-foreground">
        {formatNumber(Math.round(d.dispatch_left_this_tick))} L dispatch left
      </text>
    </g>
  );
}

// A live map of the network: tanks fill and drain, trucks move from depot to station as ticks pass, disrupted
// routes flash, demand spikes glow. Everything refreshes from the live stream.
export function NetworkMap() {
  const network = useNetwork();
  const allocations = useAllocations();
  const overview = useOverview();
  const tick = overview.data?.tick ?? network.data?.tick ?? 0;
  const routes = network.data?.routes ?? [];
  const byRoute = new Map(routes.map((r) => [r.id, r]));
  const moving = (allocations.data?.allocations ?? []).filter((a) => a.status === "PENDING" || a.status === "IN_TRANSIT");
  const busy = new Set(moving.map((a) => a.route_id));

  if (!network.data) {
    return <div className="aspect-[720/380] w-full animate-pulse rounded-lg bg-muted" aria-label="Loading the network" />;
  }

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Live map of depots, stations, routes and shipments">
        <rect x={8} y={8} width={352} height={H - 16} rx={12} fill="var(--background)" stroke="var(--border)" />
        <rect x={364} y={8} width={348} height={H - 16} rx={12} fill="var(--background)" stroke="var(--border)" />
        <text x={24} y={30} fontSize={10} letterSpacing={1} className="fill-muted-foreground">
          DHAKA DIVISION
        </text>
        <text x={380} y={30} fontSize={10} letterSpacing={1} className="fill-muted-foreground">
          CHATTOGRAM DIVISION
        </text>

        {routes.map((r) => {
          const a = at(r, 0);
          const b = at(r, 1);
          if (!a || !b) return null;
          const down = r.status !== "AVAILABLE" || !r.usable_now;
          return (
            <line
              key={r.id}
              x1={a[0]}
              y1={a[1]}
              x2={b[0]}
              y2={b[1]}
              stroke={down ? "var(--bad-fg)" : busy.has(r.id) ? "var(--chart-3)" : "var(--chart-1)"}
              strokeWidth={down ? 2.5 : busy.has(r.id) ? 2 : 1.5}
              className={cn((down || busy.has(r.id)) && "live-flow")}
            >
              <title>{`${r.id}: ${r.transit_ticks} ticks, max ${formatNumber(r.max_shipment)} L${down ? ", DISRUPTED" : ""}`}</title>
            </line>
          );
        })}

        {network.data.depots.map((d) => (
          <DepotNode key={d.id} d={d} />
        ))}
        {network.data.stations.map((s) => (
          <StationNode key={s.id} s={s} />
        ))}

        {moving.map((m) => {
          const r = byRoute.get(m.route_id);
          const p = r ? at(r, progress(m, tick)) : null;
          if (!p) return null;
          const pending = m.status === "PENDING";
          return (
            <g key={m.id} style={{ transform: `translate(${p[0]}px, ${p[1]}px)`, transition: "transform 900ms linear" }}>
              {pending ? <circle r={9} fill="none" stroke="var(--foreground)" className="live-ring" /> : null}
              <circle r={6} fill={m.origin === "fuelops" ? "var(--foreground)" : "var(--chart-3)"} stroke="var(--card)" strokeWidth={2}>
                <title>{`${m.fuel_type} ${formatNumber(Math.round(m.quantity))} L to ${m.destination_station_id} (${m.status.toLowerCase()})`}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>● truck (our shipment)</span>
        <span>◌ waiting to depart</span>
        <span>tanks: D / P / O fill, coloured by stockout risk</span>
        <span className="text-bad-fg">red = route disrupted</span>
        <span className="text-warn-fg">glow = demand spike</span>
      </figcaption>
    </figure>
  );
}
