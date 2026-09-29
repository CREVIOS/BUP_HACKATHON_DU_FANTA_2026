import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "@/lib/api/keys";
import { createInvalidator, invalidationsFor, reconnectDelay } from "@/lib/api/stream";

describe("invalidationsFor", () => {
  it("maps each stream event to the data it changes (docs/API.md section 6)", () => {
    expect(invalidationsFor("tick")).toEqual(
      expect.arrayContaining([keys.overview, keys.network, keys.risk, keys.supply, keys.events, keys.demandAll]),
    );
    expect(invalidationsFor("alerts")).toEqual(expect.arrayContaining([keys.alertsAll, keys.overview]));
    expect(invalidationsFor("recommendations")).toEqual(
      expect.arrayContaining([keys.recommendationsAll, keys.decisions, keys.overview]),
    );
    expect(invalidationsFor("allocations")).toEqual([keys.allocations]);
    expect(invalidationsFor("commands")).toEqual([keys.commands]);
  });

  it("ignores unknown events", () => {
    expect(invalidationsFor("mystery")).toEqual([]);
  });
});

describe("createInvalidator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst of events into one refresh per key", () => {
    const invalidate = vi.fn();
    const push = createInvalidator(invalidate, 500);
    for (let i = 0; i < 20; i++) push("tick");
    push("alerts");
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    const refreshed = invalidate.mock.calls.map(([key]) => JSON.stringify(key));
    expect(new Set(refreshed).size).toBe(refreshed.length);
    expect(refreshed).toContain(JSON.stringify(keys.overview));
    expect(refreshed).toContain(JSON.stringify(keys.alertsAll));
  });
});

describe("reconnectDelay", () => {
  it("backs off from 3 s, doubling, capped at 30 s", () => {
    expect([0, 1, 2, 3, 4, 10].map(reconnectDelay)).toEqual([3000, 6000, 12000, 24000, 30000, 30000]);
  });
});
