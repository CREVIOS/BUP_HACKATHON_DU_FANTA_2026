import { parseHealth } from "@/lib/health";
import type { Snapshot } from "@/lib/types";

// How far the facts can be trusted. Snapshot age is NOT used: a paused simulator legitimately stops
// writing snapshots. Freshness comes from the simulator's stale flag and the ingestor/database health.
export interface DataQuality {
  stale: boolean; // the simulator reported stale data
  sourceHealthy: boolean; // the ingestor is polling and the database is up
  reason?: string;
}

export const HEALTHY_DATA: DataQuality = { stale: false, sourceHealthy: true };

const FRESHNESS_COMPONENTS = ["fuel_simulator", "database"] as const;

export function assessQuality(
  state: { stale?: boolean },
  status: Record<string, unknown> | undefined,
): DataQuality {
  let stale = state.stale === true;
  if (!status) {
    return { stale, sourceHealthy: false, reason: "Could not confirm the health of the data source." };
  }
  for (const key of FRESHNESS_COMPONENTS) {
    const { health, reason } = parseHealth(status[key]);
    if (health === "ok") continue;
    // "degraded" on the simulator means its data is flagged stale: still flowing, not trustworthy.
    if (health === "degraded" && key === "fuel_simulator") {
      stale = true;
      continue;
    }
    return { stale, sourceHealthy: false, reason: `${key.replace("_", " ")}: ${reason ?? "status unknown"}` };
  }
  return { stale, sourceHealthy: true };
}

// Everything an AI feature needs: the facts, and how far to trust them.
export interface LoadedState {
  snapshot: Snapshot;
  quality: DataQuality;
}
