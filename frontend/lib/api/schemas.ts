// zod schemas for the operator API (docs/API.md). Every response is validated at the boundary: a
// response that does not match is rejected and reported, never rendered (brief section 11).
// zod/mini keeps the browser bundle small; unknown response fields are stripped, unknown request
// fields are refused (the API answers them with 400 INVALID_BODY).
import * as z from "zod/mini";

// Go encodes an empty slice as null. Accept it and hand the UI an empty array.
const list = <T extends z.core.$ZodType>(item: T) =>
  z.pipe(
    z.nullable(z.array(item)),
    z.transform((value) => value ?? []),
  );
const maybe = <T extends z.core.$ZodType>(schema: T) => z.optional(z.nullable(schema));
const liters = z.number();
const text = (max: number) => z.string().check(z.minLength(1), z.maxLength(max));

export const fuelSchema = z.enum(["DIESEL", "PETROL", "OCTANE"]);
export const riskLevelSchema = z.enum(["critical", "high", "elevated", "normal"]);
export const severitySchema = z.enum(["CRITICAL", "WARN", "INFO"]);
export const roleSchema = z.enum(["viewer", "operator", "admin"]);
export const recommendationStatusSchema = z.enum(["PROPOSED", "APPROVED", "REJECTED", "SUBMITTED", "EXPIRED", "FAILED"]);

// ---------- responses ----------

const simMetricsSchema = z.object({
  served_demand_liters: liters,
  unmet_demand_liters: liters,
  service_level: z.number(),
  allocation_liters: liters,
  allocation_failures: z.number(),
});

export const overviewSchema = z.object({
  simulation_only: z.boolean(),
  epoch_id: z.number(),
  scenario_id: z.string(),
  tick: z.number(),
  sim_time: z.string(),
  sim_status: z.string(),
  tick_minutes: z.number(),
  stale: z.boolean(),
  data_age_seconds: z.number(),
  degraded: z.boolean(),
  sim_metrics: maybe(simMetricsSchema),
  open_alerts: z.object({ critical: z.number(), warn: z.number(), info: z.number() }),
  review_queue: z.number(),
  disruptions: z.object({ active: z.number(), scheduled: z.number() }),
  decision_source: z.string(),
  auto_execute: z.boolean(),
  inventory_liters: z.object({
    depots: z.record(z.string(), liters),
    stations: z.record(z.string(), liters),
    in_transit: z.record(z.string(), liters),
  }),
});

// Component -> "healthy" | "degraded: why" | "unhealthy: why", plus request metrics.
export const statusSchema = z.record(z.string(), z.union([z.string(), z.number()]));

const regionSchema = z.object({ id: z.string(), name: z.string(), demand_factor: z.number() });

export const networkSchema = z.object({
  tick: z.number(),
  regions: list(regionSchema),
  depots: list(
    z.object({
      id: z.string(),
      name: z.string(),
      region_id: z.string(),
      status: z.string(),
      dispatch_capacity_per_tick: liters,
      dispatch_left_this_tick: liters,
      fuels: z.record(z.string(), z.object({ inventory: liters, capacity: liters, fill: z.number() })),
    }),
  ),
  stations: list(
    z.object({
      id: z.string(),
      name: z.string(),
      region_id: z.string(),
      status: z.string(),
      demand_profile: z.string(),
      demand_multiplier: z.number(),
      fuels: z.record(
        z.string(),
        z.object({
          inventory: liters,
          capacity: liters,
          fill: z.number(),
          in_transit: liters,
          room_after_in_transit: liters,
          stockout_prob: z.number(),
          time_to_stockout_ticks: z.number(),
          time_to_stockout_hours: maybe(z.number()), // omitted or null when no stockout within 12 h
          risk_level: riskLevelSchema,
          demand_next_12h: liters,
        }),
      ),
    }),
  ),
  routes: list(
    z.object({
      id: z.string(),
      source_depot_id: z.string(),
      destination_station_id: z.string(),
      transit_ticks: z.number(),
      max_shipment: liters,
      status: z.string(),
      usable_now: z.boolean(),
      cross_region: z.boolean(),
      disruptions: list(z.object({ event_id: z.number(), status: z.string(), start_tick: z.number(), end_tick: z.number() })),
    }),
  ),
});

export const riskSchema = z.object({
  tick: z.number(),
  horizon_ticks: z.number(),
  method: z.string(),
  series: list(
    z.object({
      station_id: z.string(),
      station_name: z.string(),
      fuel_type: fuelSchema,
      risk_level: riskLevelSchema,
      stockout_prob: z.number(),
      time_to_stockout_ticks: z.number(),
      time_to_stockout_hours: maybe(z.number()), // omitted or null when no stockout within 12 h
      on_hand: liters,
      in_transit: liters,
      capacity: liters,
      demand_next_12h: liters,
      cover_ratio: maybe(z.number()),
    }),
  ),
});

export const demandSchema = z.object({
  tick: z.number(),
  series: list(
    z.object({
      station_id: z.string(),
      fuel_type: fuelSchema,
      history: list(
        z.object({ tick: z.number(), demand: liters, served: liters, unmet: liters, forecast: maybe(liters) }),
      ),
      forecast: list(z.object({ tick: z.number(), expected: liters, low: liters, high: liters })),
    }),
  ),
});

export const demandRegionsSchema = z.object({
  tick: z.number(),
  window_ticks: z.number(),
  regions: list(
    z.object({
      region_id: z.string(),
      name: z.string(),
      demand_factor: z.number(),
      station_ids: list(z.string()),
      fuels: z.record(
        z.string(),
        z.object({
          demand: liters,
          served: liters,
          unmet: liters,
          service_level: maybe(z.number()),
          forecast_next_12h: liters,
          max_demand_multiplier: z.number(),
        }),
      ),
    }),
  ),
});

export const supplySchema = z.object({
  tick: z.number(),
  arrivals: list(
    z.object({
      id: z.string(),
      depot_id: z.string(),
      fuel_type: fuelSchema,
      status: z.string(),
      quantity: liters,
      planned_tick: z.number(),
      actual_tick: maybe(z.number()),
      original_quantity: liters,
      original_planned_tick: z.number(),
      delay_ticks: z.number(),
      shortfall_liters: liters,
      eta_ticks: z.optional(z.number()),
      clip_risk_liters: z.optional(liters),
    }),
  ),
});

export const eventsSchema = z.object({
  tick: z.number(),
  events: list(
    z.object({
      id: z.number(),
      type: z.string(),
      status: z.string(),
      start_tick: z.number(),
      end_tick: z.number(),
      starts_in_ticks: z.number(),
      ends_in_ticks: z.number(),
      parameters: maybe(z.record(z.string(), z.unknown())),
      effective: z.boolean(),
      description: z.string(),
    }),
  ),
});

export const alertSchema = z.object({
  id: z.number(),
  epoch_id: maybe(z.number()),
  tick: maybe(z.number()),
  kind: z.string(),
  severity: severitySchema,
  subject: maybe(z.string()),
  detail: maybe(z.record(z.string(), z.unknown())),
  open: z.boolean(),
  created_at: z.string(),
  resolved_at: maybe(z.string()),
  acked_at: maybe(z.string()),
  acked_by: maybe(z.string()),
});
export const alertsSchema = z.object({ alerts: list(alertSchema) });

// brief section 9: why, signals, constraints, impact, confidence, alternatives. Manual allocations
// carry {manual, reason, what_if} instead, so every field is optional.
const explanationSchema = z.object({
  arrival_tick: z.optional(z.number()),
  transit_ticks: z.optional(z.number()),
  time_to_stockout: z.optional(z.number()),
  binding_constraint: maybe(z.string()),
  signals: maybe(z.record(z.string(), z.number())),
  alternatives: z.optional(
    list(z.object({ route_id: z.string(), depot_id: z.string(), transit_ticks: z.number(), rejected: z.string() })),
  ),
  review_reasons: z.optional(list(z.string())),
  rule_reasons: z.optional(list(z.string())),
  features: maybe(z.record(z.string(), z.string())),
  manual: z.optional(z.boolean()),
  reason: maybe(z.string()),
});

const outboxSchema = z.object({
  status: z.string(),
  attempts: z.number(),
  last_error: maybe(z.string()),
  sim_allocation_id: maybe(z.number()),
});

export const recommendationSchema = z.object({
  id: z.number(),
  epoch_id: z.number(),
  tick: z.number(),
  station_id: z.string(),
  fuel_type: fuelSchema,
  depot_id: z.string(),
  route_id: z.string(),
  quantity: liters,
  policy_version: z.string(),
  source: z.string(),
  risk_before: maybe(z.number()),
  risk_after: maybe(z.number()),
  rule_verdict: maybe(z.string()),
  jev_p_auto: maybe(z.number()),
  jev_model: maybe(z.string()),
  verdict: z.string(),
  status: recommendationStatusSchema,
  created_at: z.string(),
  explanation: z.pipe(
    maybe(explanationSchema),
    z.transform((value) => value ?? {}),
  ),
  outbox: maybe(outboxSchema),
});
export const recommendationsSchema = z.object({ tick: z.number(), recommendations: list(recommendationSchema) });

export const allocationSchema = z.object({
  id: z.number(),
  idempotency_key: maybe(z.string()),
  source_depot_id: z.string(),
  destination_station_id: z.string(),
  route_id: z.string(),
  fuel_type: fuelSchema,
  quantity: liters,
  created_tick: z.number(),
  departure_tick: maybe(z.number()),
  expected_arrival_tick: maybe(z.number()),
  actual_arrival_tick: maybe(z.number()),
  status: z.string(),
  failure_reason: maybe(z.string()),
  origin: z.optional(z.string()),
  recommendation_id: maybe(z.number()),
});

const decisionEntrySchema = z.object({
  id: z.number(),
  actor: z.string(),
  action: z.string(),
  reason: maybe(z.string()),
  created_at: z.string(),
});

export const recommendationDetailSchema = z.object({
  recommendation: recommendationSchema,
  decisions: list(decisionEntrySchema),
  sim_allocation: maybe(allocationSchema),
  still_valid: z.optional(z.boolean()),
  violations: z.optional(list(z.string())),
});

export const allocationsSchema = z.object({
  tick: z.number(),
  allocations: list(allocationSchema),
  queued: list(
    z.object({
      outbox_id: z.number(),
      recommendation_id: maybe(z.number()),
      status: z.string(),
      attempts: z.number(),
      last_error: maybe(z.string()),
      updated_at: z.string(),
    }),
  ),
});

export const decisionsSchema = z.object({
  decisions: list(
    z.extend(decisionEntrySchema, {
      recommendation: z.object({
        id: z.number(),
        epoch_id: z.number(),
        tick: z.number(),
        station_id: z.string(),
        fuel_type: fuelSchema,
        route_id: z.string(),
        quantity: liters,
        status: z.string(),
        source: z.string(),
        verdict: z.string(),
        risk_before: maybe(z.number()),
        risk_after: maybe(z.number()),
      }),
      outcome: z.object({
        submission: maybe(z.string()),
        error: maybe(z.string()),
        sim_allocation_id: maybe(z.number()),
        sim_status: maybe(z.string()),
      }),
    }),
  ),
});

const projectionPointSchema = z.object({
  stockout_prob: z.number(),
  time_to_stockout_ticks: z.number(),
  time_to_stockout_hours: maybe(z.number()), // omitted or null when no stockout within 12 h
  risk_level: riskLevelSchema,
  position: liters,
});

export const simulateResultSchema = z.object({
  tick: z.number(),
  valid: z.boolean(),
  violations: list(z.string()),
  before: z.optional(projectionPointSchema),
  after: z.optional(projectionPointSchema),
  risk_reduction: z.optional(z.number()),
  arrival_tick: z.optional(z.number()),
});

export const intelQualitySchema = z.object({
  tick: z.number(),
  window_ticks: z.number(),
  forecast: z.object({
    observations: z.number(),
    mape: maybe(z.number()),
    naive_mape: maybe(z.number()),
    note: z.string(),
  }),
  recommendations: z.object({
    by_source_verdict: z.record(z.string(), z.number()),
    by_status: z.record(z.string(), z.number()),
  }),
  outbox: z.record(z.string(), z.number()),
  jev: z.object({
    asked: z.number(),
    avg_p_auto: maybe(z.number()),
    agreed_with_rule: z.number(),
    overrode_rule: z.number(),
  }),
  alerts_by_kind: z.record(z.string(), z.number()),
});

export const policySchema = z.object({
  policy_version: z.string(),
  auto_execute: z.boolean(),
  jev_threshold: z.number(),
  jev_configured: z.boolean(),
  updated_by: maybe(z.string()),
  updated_at: maybe(z.string()),
  options: z.record(z.string(), z.number()),
  review_rule: list(z.string()),
});

export const meSchema = z.object({ role: roleSchema, actor: z.string(), auth_enabled: z.boolean() });

export const commandSchema = z.object({
  id: z.number(),
  kind: z.string(),
  payload: z.unknown(),
  status: z.enum(["PENDING", "DONE", "FAILED"]),
  result: z.unknown(),
  error: maybe(z.string()),
  requested_by: z.string(),
  created_at: z.string(),
  done_at: maybe(z.string()),
});
export const commandsSchema = z.object({ commands: list(commandSchema) });

export const ackResultSchema = z.object({ id: z.number(), acked_by: z.string() });

export const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.optional(list(z.string())) }),
});

// ---------- requests (strict: the API refuses unknown fields) ----------

export const approveBodySchema = z.strictObject({
  reason: z.optional(text(500)),
  quantity: z.optional(z.number().check(z.positive())),
});

export const rejectBodySchema = z.strictObject({ reason: text(500) });

export const simulateBodySchema = z.strictObject({
  station_id: text(80),
  fuel_type: fuelSchema,
  route_id: text(80),
  quantity: z.number().check(z.positive()),
});

export const manualAllocationBodySchema = z.strictObject({
  station_id: text(80),
  fuel_type: fuelSchema,
  route_id: text(80),
  quantity: z.number().check(z.positive()),
  reason: text(500),
});

export const stepBodySchema = z.strictObject({ count: z.int().check(z.minimum(1), z.maximum(96)) });

export const eventTypeSchema = z.enum([
  "demand_spike",
  "route_disruption",
  "station_outage",
  "depot_constraint",
  "shipment_delay",
  "supply_shortfall",
]);

export const eventBodySchema = z.strictObject({
  type: eventTypeSchema,
  start_tick: z.optional(z.int().check(z.minimum(0))),
  start_in: z.optional(z.int().check(z.minimum(0), z.maximum(2000))),
  duration_ticks: z.int().check(z.minimum(1), z.maximum(2000)),
  parameters: z.optional(z.record(z.string(), z.unknown())),
});

export const faultTypeSchema = z.enum(["latency", "unavailable", "error_rate", "stale_data", "stream_disconnect"]);

export const faultBodySchema = z.strictObject({
  type: faultTypeSchema,
  duration_seconds: z.int().check(z.minimum(1), z.maximum(3600)),
  parameters: z.optional(z.record(z.string(), z.number())),
});

export const policyBodySchema = z.strictObject({
  auto_execute: z.optional(z.boolean()),
  jev_threshold: z.optional(z.number().check(z.positive(), z.maximum(1))),
});

// ---------- types ----------

export type Fuel = z.infer<typeof fuelSchema>;
export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type Role = z.infer<typeof roleSchema>;
export type Overview = z.infer<typeof overviewSchema>;
export type Status = z.infer<typeof statusSchema>;
export type Network = z.infer<typeof networkSchema>;
export type NetworkStation = Network["stations"][number];
export type NetworkDepot = Network["depots"][number];
export type NetworkRoute = Network["routes"][number];
export type Risk = z.infer<typeof riskSchema>;
export type RiskSeries = Risk["series"][number];
export type Demand = z.infer<typeof demandSchema>;
export type DemandRegions = z.infer<typeof demandRegionsSchema>;
export type Supply = z.infer<typeof supplySchema>;
export type SupplyArrival = Supply["arrivals"][number];
export type Events = z.infer<typeof eventsSchema>;
export type SimEvent = Events["events"][number];
export type Alert = z.infer<typeof alertSchema>;
export type Alerts = z.infer<typeof alertsSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;
export type Recommendations = z.infer<typeof recommendationsSchema>;
export type RecommendationDetail = z.infer<typeof recommendationDetailSchema>;
export type Allocation = z.infer<typeof allocationSchema>;
export type Allocations = z.infer<typeof allocationsSchema>;
export type Decisions = z.infer<typeof decisionsSchema>;
export type SimulateResult = z.infer<typeof simulateResultSchema>;
export type IntelQuality = z.infer<typeof intelQualitySchema>;
export type Policy = z.infer<typeof policySchema>;
export type Me = z.infer<typeof meSchema>;
export type Command = z.infer<typeof commandSchema>;
export type Commands = z.infer<typeof commandsSchema>;
export type AckResult = z.infer<typeof ackResultSchema>;
export type ApproveBody = z.input<typeof approveBodySchema>;
export type RejectBody = z.input<typeof rejectBodySchema>;
export type SimulateBody = z.input<typeof simulateBodySchema>;
export type ManualAllocationBody = z.input<typeof manualAllocationBodySchema>;
export type StepBody = z.input<typeof stepBodySchema>;
export type EventBody = z.input<typeof eventBodySchema>;
export type FaultBody = z.input<typeof faultBodySchema>;
export type PolicyBody = z.input<typeof policyBodySchema>;
