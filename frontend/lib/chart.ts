import type { Demand } from "@/lib/api/schemas";

// Round a maximum up to 1, 2 or 5 times a power of ten so axis ticks are clean numbers.
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((m) => m * power >= value) ?? 10;
  return step * power;
}

export function ticksBetween(max: number, count: number): number[] {
  return Array.from({ length: count + 1 }, (_, i) => (max / count) * i);
}

export interface DemandPoint {
  tick: number;
  observed?: number;
  forecast?: number;
  low?: number;
  high?: number;
}

// Past ticks carry what was observed and what had been forecast for them; future ticks carry the
// forecast and its band.
export function demandPoints(series: Pick<Demand["series"][number], "history" | "forecast">): DemandPoint[] {
  const past = series.history.map((h) => ({ tick: h.tick, observed: h.demand, forecast: h.forecast ?? undefined }));
  const future = series.forecast.map((f) => ({ tick: f.tick, forecast: f.expected, low: f.low, high: f.high }));
  return [...past, ...future].sort((a, b) => a.tick - b.tick);
}
