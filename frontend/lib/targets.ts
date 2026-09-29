import type { Alert } from "@/lib/api/schemas";

export type Tab = "live" | "overview" | "decisions" | "network" | "control";

// Where to take the operator: a tab, optionally a section on it, or a station+fuel to review.
export interface Target {
  tab: Tab;
  section?: string;
  seriesKey?: string; // "station-id:FUEL", selects that recommendation in Decisions
}

// Each alert kind (docs/API.md section 7) opens the page where the operator can act on it.
export function alertTarget(alert: Pick<Alert, "kind" | "subject">): Target {
  const subject = alert.subject ?? "";
  switch (alert.kind) {
    case "stockout_risk":
      return subject.includes(":") ? { tab: "decisions", seriesKey: subject } : { tab: "network", section: "stations" };
    case "station_outage":
      return { tab: "network", section: "stations" };
    case "demand_anomaly":
      return { tab: "network", section: "demand" };
    case "depot_low":
      return { tab: "network", section: "depots" };
    case "disruption":
    case "disruption_upcoming":
      return { tab: "network", section: "routes" };
    case "supply_delay":
    case "supply_shortfall":
    case "allocation_failed":
    case "loss_prevented":
      return { tab: "network", section: "activity" };
    default:
      return { tab: "overview", section: "system" };
  }
}
