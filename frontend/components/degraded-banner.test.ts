import { describe, expect, it } from "vitest";
import overview from "@/lib/api/__fixtures__/overview.json";
import { overviewSchema } from "@/lib/api/schemas";
import { ApiError } from "@/lib/api/http";
import { degradedReasons } from "@/components/degraded-banner";

const ov = overviewSchema.parse(overview);
const healthy = { fuel_simulator: "healthy", database: "healthy" };

describe("degradedReasons", () => {
  it("is empty when everything is healthy", () => {
    expect(degradedReasons({ overview: ov, status: healthy, error: null, updatedAt: 1 })).toEqual([]);
  });

  it("says the simulator feed is down and how old the data is", () => {
    const reasons = degradedReasons({
      overview: { ...ov, data_age_seconds: 42.3 },
      status: { ...healthy, fuel_simulator: "unhealthy: no successful simulator poll for 16s" },
      error: null,
      updatedAt: 1,
    });
    expect(reasons.join(" ")).toMatch(/no successful simulator poll for 16s/);
    expect(reasons.join(" ")).toMatch(/42 s old/);
  });

  it("reports the fallback policy and stale data", () => {
    const reasons = degradedReasons({ overview: { ...ov, stale: true, decision_source: "fallback" }, status: healthy, error: null, updatedAt: 1 });
    expect(reasons.join(" ")).toMatch(/stale/);
    expect(reasons.join(" ")).toMatch(/fallback policy/);
  });

  it("distinguishes an unreachable API from an invalid response", () => {
    expect(degradedReasons({ overview: ov, status: healthy, error: new ApiError(0, "NETWORK", "x"), updatedAt: 1 }).join(" ")).toMatch(/Cannot reach the API/);
    expect(degradedReasons({ overview: ov, status: healthy, error: new ApiError(200, "INVALID_RESPONSE", "x"), updatedAt: 1 }).join(" ")).toMatch(/could not validate/);
  });
});
