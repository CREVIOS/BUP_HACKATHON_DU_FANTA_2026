import { describe, expect, it } from "vitest";
import { describeSubject } from "@/lib/names";

const names = new Map([["station-tongi", "Tongi Industrial Station"]]);

describe("describeSubject", () => {
  it("resolves a station and fuel", () => {
    expect(describeSubject("station-tongi:DIESEL", names)).toBe("Tongi Industrial Station, diesel");
  });
  it("keeps unknown ids and handles empty subjects", () => {
    expect(describeSubject("event-2", names)).toBe("event-2");
    expect(describeSubject(null, names)).toBe("");
  });
});
