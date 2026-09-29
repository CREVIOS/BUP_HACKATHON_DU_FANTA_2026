import { describe, expect, it } from "vitest";
import { probabilities, strategy } from "@/lib/rl";

describe("rl", () => {
  it("names actions like the backend", () => {
    expect(strategy(0)).toBe("wait");
    expect(strategy(1)).toBe("2h cover, urgency");
    expect(strategy(9)).toBe("12h cover, urgency");
    expect(strategy(12)).toBe("12h cover, scarcity-aware");
  });

  it("is a softmax over the valid actions only", () => {
    const logits = [1, 2, 99, 0];
    const mask = [true, true, false, true];
    const p = probabilities(logits, mask);
    expect(p.map((o) => o.action)).toEqual([1, 0, 3]);
    expect(p.reduce((a, o) => a + o.probability, 0)).toBeCloseTo(1, 10);
    expect(p[0].probability).toBeCloseTo(Math.exp(2) / (Math.exp(1) + Math.exp(2) + Math.exp(0)), 10);
  });

  it("returns nothing for missing or mismatched inputs", () => {
    expect(probabilities(undefined, [true])).toEqual([]);
    expect(probabilities([1, 2], [true])).toEqual([]);
  });
});
