import { describe, expect, it } from "vitest";
import { loadContext } from "@/lib/ai/backend";
import { BASELINE } from "@/lib/mock/baseline";

const HEALTHY = { backend_api: "healthy", database: "healthy", fuel_simulator: "healthy", decision_engine: "healthy" };

// Fake fetch that answers by URL suffix.
const api = (routes: Record<string, { body?: unknown; status?: number; throws?: boolean }>) => async (url: string) => {
  const hit = Object.entries(routes).find(([suffix]) => url.endsWith(suffix))?.[1];
  if (!hit || hit.throws) throw new TypeError("fetch failed");
  return new Response(JSON.stringify(hit.body ?? {}), { status: hit.status ?? 200 });
};

describe("loadContext", () => {
  it("reads the snapshot and the source health from the API", async () => {
    const fetchImpl = api({ "/api/state": { body: { tick: 0, stale: false, snapshot: BASELINE } }, "/api/status": { body: HEALTHY } });
    const { snapshot, quality } = await loadContext(fetchImpl);
    expect(snapshot.instance.scenario_id).toBe("baseline");
    expect(quality.sourceHealthy).toBe(true);
  });

  it("reports an unhealthy feed instead of pretending the snapshot is current", async () => {
    const fetchImpl = api({
      "/api/state": { body: { tick: 9, stale: false, snapshot: BASELINE } },
      "/api/status": { body: { ...HEALTHY, fuel_simulator: "unhealthy: no successful simulator poll for 42s" } },
    });
    const { quality } = await loadContext(fetchImpl);
    expect(quality.sourceHealthy).toBe(false);
    expect(quality.reason).toContain("42s");
  });

  it("carries the simulator's stale flag", async () => {
    const fetchImpl = api({ "/api/state": { body: { tick: 9, stale: true, snapshot: BASELINE } }, "/api/status": { body: HEALTHY } });
    expect((await loadContext(fetchImpl)).quality.stale).toBe(true);
  });

  it("still returns the snapshot, but unconfirmed, when only the status call fails", async () => {
    const fetchImpl = api({ "/api/state": { body: { tick: 0, snapshot: BASELINE } }, "/api/status": { throws: true } });
    const { quality } = await loadContext(fetchImpl);
    expect(quality.sourceHealthy).toBe(false);
    expect(quality.reason).toMatch(/could not confirm/i);
  });

  it("throws when the state call fails or has no snapshot yet", async () => {
    await expect(loadContext(api({ "/api/state": { status: 500 }, "/api/status": { body: HEALTHY } }))).rejects.toThrow(/500/);
    await expect(loadContext(api({ "/api/state": { body: { tick: null } }, "/api/status": { body: HEALTHY } }))).rejects.toThrow(/snapshot/i);
    await expect(loadContext(api({ "/api/state": { throws: true } }))).rejects.toThrow(/fetch failed/);
  });
});
