import { eventBodySchema, faultBodySchema, type EventBody, type FaultBody } from "@/lib/api/schemas";

export type EventType = EventBody["type"];
export type FaultType = FaultBody["type"];

// Which id list each event type targets (docs/API.md 5.18).
export const EVENT_TARGET: Record<EventType, { key: string; kind: "region" | "route" | "station" | "depot"; required: boolean }> = {
  demand_spike: { key: "region_ids", kind: "region", required: false },
  route_disruption: { key: "route_ids", kind: "route", required: true },
  station_outage: { key: "station_ids", kind: "station", required: true },
  depot_constraint: { key: "depot_ids", kind: "depot", required: true },
  shipment_delay: { key: "depot_ids", kind: "depot", required: false },
  supply_shortfall: { key: "depot_ids", kind: "depot", required: false },
};

export interface CrisisForm {
  type: EventType;
  targetIds: string[];
  startIn: number;
  duration: number;
  multiplier?: number; // demand_spike, 0.05..10
  delayTicks?: number; // shipment_delay, 1..500
  factor?: number; // supply_shortfall, 0..1
}

type Built<T> = { ok: true; body: T } | { ok: false; error: string };

export function buildEventBody(form: CrisisForm): Built<EventBody> {
  const target = EVENT_TARGET[form.type];
  if (target.required && form.targetIds.length === 0) {
    return { ok: false, error: `Pick at least one ${target.kind}: with none, the simulator ignores this event.` };
  }
  const parameters: Record<string, unknown> = {};
  if (form.targetIds.length > 0) parameters[target.key] = [...form.targetIds];
  if (form.type === "demand_spike") {
    const multiplier = form.multiplier ?? 1.5;
    if (!(multiplier >= 0.05 && multiplier <= 10)) return { ok: false, error: "Multiplier must be between 0.05 and 10." };
    parameters.multiplier = multiplier;
  }
  if (form.type === "shipment_delay" && form.delayTicks !== undefined) parameters.delay_ticks = form.delayTicks;
  if (form.type === "supply_shortfall" && form.factor !== undefined) parameters.factor = form.factor;

  const body = { type: form.type, start_in: form.startIn, duration_ticks: form.duration, parameters };
  const valid = eventBodySchema.safeParse(body);
  if (!valid.success) return { ok: false, error: "Check the start and duration (0 to 2000 ticks, duration at least 1)." };
  return { ok: true, body };
}

export interface FaultForm {
  type: FaultType;
  durationSeconds: number;
  value?: number; // latency: delay_ms 0..10000, error_rate: rate 0..1
}

const FAULT_PARAM: Partial<Record<FaultType, { key: string; min: number; max: number; label: string }>> = {
  latency: { key: "delay_ms", min: 0, max: 10_000, label: "Delay must be 0 to 10000 ms." },
  error_rate: { key: "rate", min: 0, max: 1, label: "Error rate must be between 0 and 1." },
};

export function buildFaultBody(form: FaultForm): Built<FaultBody> {
  const param = FAULT_PARAM[form.type];
  const body: FaultBody = { type: form.type, duration_seconds: form.durationSeconds };
  if (param && form.value !== undefined) {
    if (!(form.value >= param.min && form.value <= param.max)) return { ok: false, error: param.label };
    body.parameters = { [param.key]: form.value };
  }
  const valid = faultBodySchema.safeParse(body);
  if (!valid.success) return { ok: false, error: "Duration must be 1 to 3600 seconds." };
  return { ok: true, body };
}
