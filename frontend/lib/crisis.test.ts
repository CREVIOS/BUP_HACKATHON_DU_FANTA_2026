import { describe, expect, it } from "vitest";
import { buildEventBody, buildFaultBody } from "@/lib/crisis";

describe("buildEventBody", () => {
  it("puts targets under the id list the event type uses", () => {
    const result = buildEventBody({ type: "route_disruption", targetIds: ["route-gazipur-mirpur"], startIn: 2, duration: 6 });
    expect(result).toEqual({
      ok: true,
      body: { type: "route_disruption", start_in: 2, duration_ticks: 6, parameters: { route_ids: ["route-gazipur-mirpur"] } },
    });
  });

  it("requires a target for route, station and depot events (an empty list does nothing in the simulator)", () => {
    for (const type of ["route_disruption", "station_outage", "depot_constraint"] as const) {
      expect(buildEventBody({ type, targetIds: [], startIn: 0, duration: 4 })).toMatchObject({ ok: false });
    }
  });

  it("lets a demand spike cover every region when none is picked, with its multiplier", () => {
    const result = buildEventBody({ type: "demand_spike", targetIds: [], startIn: 0, duration: 12, multiplier: 1.8 });
    expect(result).toEqual({ ok: true, body: { type: "demand_spike", start_in: 0, duration_ticks: 12, parameters: { multiplier: 1.8 } } });
  });

  it("refuses a multiplier of 0, which would crash the simulator", () => {
    expect(buildEventBody({ type: "demand_spike", targetIds: [], startIn: 0, duration: 4, multiplier: 0 })).toMatchObject({ ok: false });
  });

  it("carries delay and shortfall parameters", () => {
    expect(buildEventBody({ type: "shipment_delay", targetIds: ["depot-patiya"], startIn: 0, duration: 1, delayTicks: 8 })).toMatchObject({
      ok: true,
      body: { parameters: { depot_ids: ["depot-patiya"], delay_ticks: 8 } },
    });
    expect(buildEventBody({ type: "supply_shortfall", targetIds: [], startIn: 0, duration: 1, factor: 0.5 })).toMatchObject({
      ok: true,
      body: { parameters: { factor: 0.5 } },
    });
  });

  it("rejects out-of-range timing", () => {
    expect(buildEventBody({ type: "demand_spike", targetIds: [], startIn: 0, duration: 0, multiplier: 1.5 })).toMatchObject({ ok: false });
  });
});

describe("buildFaultBody", () => {
  it("adds only the parameter the fault type takes", () => {
    expect(buildFaultBody({ type: "latency", durationSeconds: 60, value: 800 })).toEqual({
      ok: true,
      body: { type: "latency", duration_seconds: 60, parameters: { delay_ms: 800 } },
    });
    expect(buildFaultBody({ type: "error_rate", durationSeconds: 30, value: 0.25 })).toMatchObject({ ok: true, body: { parameters: { rate: 0.25 } } });
    expect(buildFaultBody({ type: "unavailable", durationSeconds: 60 })).toEqual({ ok: true, body: { type: "unavailable", duration_seconds: 60 } });
  });

  it("rejects an error rate outside 0..1 and a bad duration", () => {
    expect(buildFaultBody({ type: "error_rate", durationSeconds: 30, value: 2 })).toMatchObject({ ok: false });
    expect(buildFaultBody({ type: "unavailable", durationSeconds: 0 })).toMatchObject({ ok: false });
  });
});
