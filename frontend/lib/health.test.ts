import { describe, expect, it } from "vitest";
import { parseHealth } from "@/lib/health";

describe("parseHealth", () => {
  it.each([
    ["healthy", { health: "ok" }],
    ["configured", { health: "ok" }],
    ["degraded: fallback policy active (intel down)", { health: "degraded", reason: "fallback policy active (intel down)" }],
    ["unhealthy: no successful simulator poll for 13s", { health: "down", reason: "no successful simulator poll for 13s" }],
    ["disabled: fixed review rule only", { health: "off", reason: "fixed review rule only" }],
    ["unhealthy", { health: "down" }],
  ])("parses %j", (value, expected) => {
    expect(parseHealth(value)).toEqual(expected);
  });

  it("treats missing or unknown values as unknown, never ok", () => {
    expect(parseHealth(undefined)).toEqual({ health: "unknown" });
    expect(parseHealth(42)).toEqual({ health: "unknown" });
    expect(parseHealth("weird")).toEqual({ health: "unknown", reason: "weird" });
  });
});
