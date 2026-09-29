import type { AxiosAdapter, AxiosResponse } from "axios";
import { describe, expect, it } from "vitest";
import overview from "@/lib/api/__fixtures__/overview.json";
import { createApi } from "@/lib/api/client";
import { createHttp } from "@/lib/api/http";

function recording(data: unknown) {
  const calls: { method?: string; url?: string; data?: unknown }[] = [];
  const adapter: AxiosAdapter = async (config) => {
    calls.push({ method: config.method, url: config.url, data: config.data });
    return { data, status: 200, statusText: "", headers: {}, config } as AxiosResponse;
  };
  return { api: createApi(createHttp(adapter)), calls };
}

describe("createApi", () => {
  it("returns parsed data for a valid response", async () => {
    const { api } = recording(overview);
    expect((await api.overview()).tick).toBe(overview.tick);
  });

  it("rejects an invalid response instead of rendering it (brief section 11)", async () => {
    const { api } = recording({ ...overview, tick: "not a number" });
    await expect(api.overview()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("validates a request body before anything is sent", async () => {
    const { api, calls } = recording({});
    await expect(api.reject(12, { reason: "" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(calls).toHaveLength(0);
  });

  it("encodes path ids and sends the validated body", async () => {
    const { api, calls } = recording({});
    await api.reject(12, { reason: "crew unavailable" }).catch(() => undefined);
    expect(calls[0]).toMatchObject({ method: "post", url: "/api/recommendations/12/reject" });
    expect(JSON.parse(String(calls[0].data))).toEqual({ reason: "crew unavailable" });
  });

  it("refuses a non-integer id", async () => {
    const { api, calls } = recording({});
    await expect(api.recommendation(Number.NaN)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(calls).toHaveLength(0);
  });
});
