import type { Overview, Status } from "@/lib/api/schemas";
import { isApiError } from "@/lib/api/http";
import { formatClock } from "@/lib/format";
import { parseHealth } from "@/lib/health";

interface Inputs {
  overview?: Overview;
  status?: Status;
  error: unknown;
  updatedAt: number;
}

// Every reason the numbers on screen may not be current (brief section 11), in plain words.
export function degradedReasons({ overview, status, error, updatedAt }: Inputs): string[] {
  const reasons: string[] = [];
  if (error) {
    const invalid = isApiError(error) && error.code === "INVALID_RESPONSE";
    reasons.push(invalid ? "The API sent data this page could not validate, so it was not shown." : "Cannot reach the API.");
    if (overview && updatedAt > 0) reasons.push(`Showing the last good data from ${formatClock(updatedAt)}.`);
  }
  const simulator = parseHealth(status?.fuel_simulator);
  if (simulator.health === "down") {
    const age = overview ? ` Showing the last good data, ${Math.round(overview.data_age_seconds)} s old.` : "";
    reasons.push(`Simulator feed down: ${simulator.reason ?? "no recent poll"}.${age}`);
  }
  if (overview?.stale) reasons.push("The simulator flagged its data as stale. Every recommendation needs review.");
  if (overview?.decision_source === "fallback") reasons.push("Decision engine unavailable: the fallback policy is deciding.");
  return reasons;
}

export function DegradedBanner(props: Inputs) {
  const reasons = degradedReasons(props);
  if (reasons.length === 0) return null;
  return (
    <div role="alert" className="mb-6 rounded-lg bg-bad-bg px-4 py-3 text-sm text-bad-fg">
      {reasons.join(" ")}
    </div>
  );
}
