import { describe, expect, it } from "vitest";
import { formatHours, formatProbability, formatSimTime, humanize, stockoutLabel } from "@/lib/format";

describe("format", () => {
  it("formats hours to stockout", () => {
    expect(formatHours(2.5)).toBe("2.5 h");
    expect(formatHours(0.5)).toBe("30 min");
    expect(formatHours(null)).toBe("none in 12 h");
    expect(formatHours(undefined)).toBe("none in 12 h");
    expect(formatHours(-1)).toBe("none in 12 h");
  });

  it("formats probabilities", () => {
    expect(formatProbability(0.724)).toBe("72%");
    expect(formatProbability(null)).toBe("n/a");
  });

  it("treats naive simulator timestamps as UTC", () => {
    expect(formatSimTime("2026-01-01T16:00:00")).toContain("16:00");
  });

  it("humanizes enum values", () => {
    expect(humanize("IN_TRANSIT")).toBe("In transit");
  });

  it("says Empty for a tank that is already dry, instead of 0 min", () => {
    expect(stockoutLabel(0, 0)).toBe("Empty");
    expect(stockoutLabel(0, 120)).toBe("now");
    expect(stockoutLabel(2.5, 900)).toBe("2.5 h");
    expect(stockoutLabel(null, 900)).toBe("none in 12 h");
  });
});
