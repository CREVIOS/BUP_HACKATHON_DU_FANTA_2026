import { describe, expect, it } from "vitest";
import overview from "@/lib/api/__fixtures__/overview.json";
import { createApi } from "@/lib/api/client";
import { createHttp } from "@/lib/api/http";
import { mockAdapter } from "@/lib/api/mock-adapter";

const api = createApi(createHttp(mockAdapter));

describe("mockAdapter", () => {
  it("serves captured fixtures through the same schemas as live data", async () => {
    expect((await api.overview()).tick).toBe(overview.tick);
    expect((await api.network()).stations.length).toBeGreaterThan(0);
    expect((await api.recommendations()).recommendations.length).toBeGreaterThan(0);
  });

  it("serves a recommendation detail for any id", async () => {
    const detail = await api.recommendation(99);
    expect(detail.recommendation.id).toBeGreaterThan(0);
  });

  it("is read-only: writes fail with a clear message", async () => {
    await expect(api.approve(1, {})).rejects.toMatchObject({ status: 409, code: "MOCK_READONLY" });
  });
});
