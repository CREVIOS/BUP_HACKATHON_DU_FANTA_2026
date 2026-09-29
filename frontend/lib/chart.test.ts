import { describe, expect, it } from "vitest";
import { demandPoints, niceMax, ticksBetween } from "@/lib/chart";

describe("niceMax", () => {
  it("rounds up to a 1, 2 or 5 step", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(87)).toBe(100);
    expect(niceMax(143)).toBe(200);
    expect(niceMax(420)).toBe(500);
    expect(niceMax(501)).toBe(1000);
  });
});

describe("ticksBetween", () => {
  it("returns evenly spaced ticks from 0 to max", () => {
    expect(ticksBetween(200, 4)).toEqual([0, 50, 100, 150, 200]);
  });
});

describe("demandPoints", () => {
  it("merges history and forecast by tick, in order", () => {
    const points = demandPoints({
      history: [
        { tick: 1, demand: 10, served: 10, unmet: 0, forecast: 9 },
        { tick: 2, demand: 12, served: 12, unmet: 0, forecast: null },
      ],
      forecast: [
        { tick: 3, expected: 11, low: 9, high: 13 },
        { tick: 4, expected: 14, low: 12, high: 16 },
      ],
    });
    expect(points).toEqual([
      { tick: 1, observed: 10, forecast: 9 },
      { tick: 2, observed: 12, forecast: undefined },
      { tick: 3, forecast: 11, low: 9, high: 13 },
      { tick: 4, forecast: 14, low: 12, high: 16 },
    ]);
  });
});
