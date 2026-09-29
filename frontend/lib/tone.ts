import type { RiskLevel } from "@/lib/api/schemas";

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

const TONES: Record<string, Tone> = {
  OPEN: "ok",
  AVAILABLE: "ok",
  RUNNING: "ok",
  ARRIVED: "ok",
  RESOLVED: "neutral",
  CONSTRAINED: "warn",
  PAUSED: "warn",
  SCHEDULED: "neutral",
  DELAYED: "warn",
  PENDING: "warn",
  ACTIVE: "warn",
  IN_TRANSIT: "info",
  OUTAGE: "bad",
  DISRUPTED: "bad",
  FAILED: "bad",
  CANCELLED: "bad",
};

export function statusTone(status: string): Tone {
  return TONES[status] ?? "neutral";
}

export const RISK_TONE: Record<RiskLevel, Tone> = { critical: "bad", high: "bad", elevated: "warn", normal: "ok" };
