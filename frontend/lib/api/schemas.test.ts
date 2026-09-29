import { describe, expect, it } from "vitest";
import * as schemas from "@/lib/api/schemas";
import adminCommands from "@/lib/api/__fixtures__/admin-commands.json";
import alerts from "@/lib/api/__fixtures__/alerts.json";
import allocations from "@/lib/api/__fixtures__/allocations.json";
import decisions from "@/lib/api/__fixtures__/decisions.json";
import demand from "@/lib/api/__fixtures__/demand.json";
import demandRegions from "@/lib/api/__fixtures__/demand-regions.json";
import errorEnvelope from "@/lib/api/__fixtures__/error-envelope.json";
import events from "@/lib/api/__fixtures__/events.json";
import intelQuality from "@/lib/api/__fixtures__/intel-quality.json";
import me from "@/lib/api/__fixtures__/me.json";
import network from "@/lib/api/__fixtures__/network.json";
import overview from "@/lib/api/__fixtures__/overview.json";
import policy from "@/lib/api/__fixtures__/policy.json";
import recommendationDetail from "@/lib/api/__fixtures__/recommendation-detail.json";
import recommendationProposed from "@/lib/api/__fixtures__/recommendation-proposed.json";
import recommendations from "@/lib/api/__fixtures__/recommendations.json";
import risk from "@/lib/api/__fixtures__/risk.json";
import simulate from "@/lib/api/__fixtures__/simulate.json";
import status from "@/lib/api/__fixtures__/status.json";
import supply from "@/lib/api/__fixtures__/supply.json";

// Every fixture is a real response captured from the running operator API.
const CASES = [
  ["overview", schemas.overviewSchema, overview],
  ["status", schemas.statusSchema, status],
  ["network", schemas.networkSchema, network],
  ["risk", schemas.riskSchema, risk],
  ["demand", schemas.demandSchema, demand],
  ["demand/regions", schemas.demandRegionsSchema, demandRegions],
  ["supply", schemas.supplySchema, supply],
  ["events", schemas.eventsSchema, events],
  ["alerts", schemas.alertsSchema, alerts],
  ["recommendations", schemas.recommendationsSchema, recommendations],
  ["recommendation detail (submitted)", schemas.recommendationDetailSchema, recommendationDetail],
  ["recommendation detail (proposed)", schemas.recommendationDetailSchema, recommendationProposed],
  ["allocations", schemas.allocationsSchema, allocations],
  ["decisions", schemas.decisionsSchema, decisions],
  ["simulate", schemas.simulateResultSchema, simulate],
  ["intel/quality", schemas.intelQualitySchema, intelQuality],
  ["policy", schemas.policySchema, policy],
  ["me", schemas.meSchema, me],
  ["admin/commands", schemas.commandsSchema, adminCommands],
  ["error envelope", schemas.errorEnvelopeSchema, errorEnvelope],
] as const;

describe("response schemas accept real API responses", () => {
  it.each(CASES)("%s", (_name, schema, fixture) => {
    const result = schema.safeParse(fixture);
    if (!result.success) console.error(result.error.issues.slice(0, 5));
    expect(result.success).toBe(true);
  });
});

describe("response schemas reject malformed data", () => {
  it("rejects a wrong type", () => {
    expect(schemas.overviewSchema.safeParse({ ...overview, tick: "51" }).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const withoutQueue: Record<string, unknown> = { ...overview };
    delete withoutQueue.review_queue;
    expect(schemas.overviewSchema.safeParse(withoutQueue).success).toBe(false);
  });

  it("rejects an unknown risk level, which the UI colours by", () => {
    const bad = { ...risk, series: [{ ...risk.series[0], risk_level: "apocalyptic" }] };
    expect(schemas.riskSchema.safeParse(bad).success).toBe(false);
  });
});

describe("list fields", () => {
  it("turn Go's null slices into empty arrays", () => {
    const rec = recommendations.recommendations[0];
    const parsed = schemas.recommendationSchema.parse({
      ...rec,
      explanation: { ...rec.explanation, alternatives: null, review_reasons: null },
    });
    expect(parsed.explanation.alternatives).toEqual([]);
    expect(parsed.explanation.review_reasons).toEqual([]);
  });
});

describe("request schemas", () => {
  it("require a reason to reject, 1 to 500 characters", () => {
    expect(schemas.rejectBodySchema.safeParse({ reason: "" }).success).toBe(false);
    expect(schemas.rejectBodySchema.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
    expect(schemas.rejectBodySchema.safeParse({ reason: "depot crew unavailable" }).success).toBe(true);
  });

  it("reject unknown fields, which the API would answer with 400 INVALID_BODY", () => {
    expect(schemas.approveBodySchema.safeParse({ reason: "ok", qty: 5 }).success).toBe(false);
    expect(schemas.approveBodySchema.safeParse({}).success).toBe(true);
  });

  it("allow a positive edited quantity only", () => {
    expect(schemas.approveBodySchema.safeParse({ quantity: 0 }).success).toBe(false);
    expect(schemas.approveBodySchema.safeParse({ quantity: 3500 }).success).toBe(true);
  });

  it("bound the step count to 1..96", () => {
    expect(schemas.stepBodySchema.safeParse({ count: 0 }).success).toBe(false);
    expect(schemas.stepBodySchema.safeParse({ count: 97 }).success).toBe(false);
    expect(schemas.stepBodySchema.safeParse({ count: 4 }).success).toBe(true);
  });

  it("validate a what-if proposal", () => {
    const ok = { station_id: "station-mirpur", fuel_type: "PETROL", route_id: "route-patiya-mirpur", quantity: 3000 };
    expect(schemas.simulateBodySchema.safeParse(ok).success).toBe(true);
    expect(schemas.simulateBodySchema.safeParse({ ...ok, fuel_type: "KEROSENE" }).success).toBe(false);
  });
});

describe("rl schemas", () => {
  it("parse the captured /api/rl and /api/rl/shadow responses", async () => {
    const rl = (await import("@/lib/api/__fixtures__/rl.json")).default;
    const shadow = (await import("@/lib/api/__fixtures__/rl-shadow.json")).default;
    expect(schemas.rlSchema.safeParse(rl).success).toBe(true);
    const parsed = schemas.rlShadowSchema.safeParse(shadow);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.decisions[0].logits).toHaveLength(13);
  });
});
