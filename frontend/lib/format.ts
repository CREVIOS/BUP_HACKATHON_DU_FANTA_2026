const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const simTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

const simTimeShort = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

export function formatNumber(n: number | undefined): string {
  return n === undefined || Number.isNaN(n) ? "n/a" : number.format(n);
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

// "IN_TRANSIT" -> "In transit"
export function humanize(value: string): string {
  const spaced = value.toLowerCase().replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// sim_time carries no timezone suffix; treat it as UTC (docs/PLAN.md section 2, fact 15).
export function formatSimTime(raw: string): string {
  const date = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(raw) ? raw : `${raw}Z`);
  return Number.isNaN(date.getTime()) ? raw : `${simTime.format(date)} UTC`;
}

// "2 Jan, 13:00" for compact stat tiles. Same UTC handling as formatSimTime.
export function formatSimTimeShort(raw: string): string {
  const date = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(raw) ? raw : `${raw}Z`);
  return Number.isNaN(date.getTime()) ? raw : simTimeShort.format(date);
}

export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString("en-GB");
}

export type StockLevel = "low" | "watch" | "ok";

export function fillRatio(inventory: number | undefined, capacity: number | undefined): number | null {
  if (inventory === undefined || capacity === undefined || capacity <= 0) return null;
  return inventory / capacity;
}

export function stockLevel(ratio: number): StockLevel {
  if (ratio < 0.2) return "low";
  if (ratio < 0.4) return "watch";
  return "ok";
}

// Hours until stockout from the risk projection; null/undefined/-1 mean "not within the 12 h horizon".
export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || hours < 0) return "none in 12 h";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return `${hours.toFixed(1)} h`;
}

export function formatProbability(p: number | null | undefined): string {
  return p === null || p === undefined || Number.isNaN(p) ? "n/a" : `${Math.round(p * 100)}%`;
}

// Time-to-stockout wording for the UI: a dry tank says so, instead of "0 min".
export function stockoutLabel(hours: number | null | undefined, onHand: number): string {
  if (onHand <= 0) return "Empty";
  if (hours !== null && hours !== undefined && hours >= 0 && hours < 1 / 60) return "now";
  return formatHours(hours);
}
