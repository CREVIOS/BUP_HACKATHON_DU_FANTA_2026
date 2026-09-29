// /api/status values: "healthy" | "degraded: <why>" | "unhealthy: <why>", and for optional services also
// "configured" | "disabled: <why>". Parse once so every view reads them the same way.
export type Health = "ok" | "degraded" | "down" | "off" | "unknown";

export interface ParsedHealth {
  health: Health;
  reason?: string;
}

const PREFIXES: readonly [string, Health][] = [
  ["unhealthy", "down"],
  ["degraded", "degraded"],
  ["disabled", "off"],
];

export function parseHealth(value: unknown): ParsedHealth {
  if (typeof value !== "string") return { health: "unknown" };
  if (value === "healthy" || value === "configured") return { health: "ok" };
  for (const [prefix, health] of PREFIXES) {
    if (value === prefix || value.startsWith(`${prefix}:`)) {
      const reason = value.slice(prefix.length + 1).trim();
      return reason ? { health, reason } : { health };
    }
  }
  return { health: "unknown", reason: value };
}
