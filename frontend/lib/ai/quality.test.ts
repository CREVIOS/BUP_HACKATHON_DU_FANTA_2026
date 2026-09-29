import { describe, expect, it } from "vitest";
import { assessQuality, HEALTHY_DATA } from "@/lib/ai/quality";

const healthy = { backend_api: "healthy", database: "healthy", fuel_simulator: "healthy", decision_engine: "healthy" };

describe("assessQuality", () => {
  it("is healthy when the state is fresh and the source reports healthy", () => {
    expect(assessQuality({ stale: false }, healthy)).toEqual(HEALTHY_DATA);
  });

  it("flags the simulator's own stale marker", () => {
    expect(assessQuality({ stale: true }, healthy)).toMatchObject({ stale: true, sourceHealthy: true });
  });

  it("flags an unhealthy simulator feed and keeps the reason", () => {
    const q = assessQuality({ stale: false }, { ...healthy, fuel_simulator: "unhealthy: no successful simulator poll for 42s" });
    expect(q).toMatchObject({ sourceHealthy: false });
    expect(q.reason).toContain("no successful simulator poll for 42s");
  });

  it("flags an unhealthy database", () => {
    expect(assessQuality({}, { ...healthy, database: "unhealthy: timeout" })).toMatchObject({ sourceHealthy: false });
  });

  it("does not claim health it could not confirm", () => {
    const q = assessQuality({ stale: false }, undefined);
    expect(q.sourceHealthy).toBe(false);
    expect(q.reason).toMatch(/could not confirm/i);
  });

  it("ignores components that do not affect data freshness", () => {
    expect(assessQuality({}, { ...healthy, decision_engine: "unhealthy: down" }).sourceHealthy).toBe(true);
  });

  it("reads a degraded simulator (stale_data fault) as stale, not as a dead source", () => {
    const q = assessQuality({ stale: false }, { ...healthy, fuel_simulator: "degraded: simulator reports stale data" });
    expect(q).toMatchObject({ stale: true, sourceHealthy: true });
  });
});
