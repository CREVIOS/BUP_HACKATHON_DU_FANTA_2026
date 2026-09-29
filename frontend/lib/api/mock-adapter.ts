// Mock mode (?mock=demo): serves real responses captured from the operator API, through the same
// axios client and zod schemas as live data. Writes are refused so nothing pretends to act.
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import adminCommands from "@/lib/api/__fixtures__/admin-commands.json";
import alerts from "@/lib/api/__fixtures__/alerts.json";
import allocations from "@/lib/api/__fixtures__/allocations.json";
import decisions from "@/lib/api/__fixtures__/decisions.json";
import demand from "@/lib/api/__fixtures__/demand.json";
import demandRegions from "@/lib/api/__fixtures__/demand-regions.json";
import events from "@/lib/api/__fixtures__/events.json";
import intelQuality from "@/lib/api/__fixtures__/intel-quality.json";
import me from "@/lib/api/__fixtures__/me.json";
import network from "@/lib/api/__fixtures__/network.json";
import overview from "@/lib/api/__fixtures__/overview.json";
import policy from "@/lib/api/__fixtures__/policy.json";
import recommendationProposed from "@/lib/api/__fixtures__/recommendation-proposed.json";
import recommendations from "@/lib/api/__fixtures__/recommendations.json";
import risk from "@/lib/api/__fixtures__/risk.json";
import status from "@/lib/api/__fixtures__/status.json";
import supply from "@/lib/api/__fixtures__/supply.json";

const GET: Record<string, unknown> = {
  "/api/overview": overview,
  "/api/status": status,
  "/api/network": network,
  "/api/risk": risk,
  "/api/demand": demand,
  "/api/demand/regions": demandRegions,
  "/api/supply": supply,
  "/api/events": events,
  "/api/alerts": alerts,
  "/api/recommendations": recommendations,
  "/api/allocations": allocations,
  "/api/decisions": decisions,
  "/api/intel/quality": intelQuality,
  "/api/policy": policy,
  "/api/me": { ...me, role: "viewer" },
  "/api/admin/commands": adminCommands,
};

function respond(config: InternalAxiosRequestConfig, status: number, data: unknown): AxiosResponse {
  const response = { data, status, statusText: "", headers: {}, config } as AxiosResponse;
  if (status >= 400) throw new AxiosError(`mock ${status}`, String(status), config, null, response);
  return response;
}

const envelope = (code: string, message: string) => ({ error: { code, message } });

export const mockAdapter: AxiosAdapter = async (config) => {
  const path = (config.url ?? "").split("?")[0];
  if ((config.method ?? "get").toLowerCase() !== "get") {
    return respond(config, 409, envelope("MOCK_READONLY", "Mock data is read-only. Switch to live data to act."));
  }
  if (/^\/api\/recommendations\/\d+$/.test(path)) return respond(config, 200, recommendationProposed);
  if (path in GET) return respond(config, 200, structuredClone(GET[path]));
  return respond(config, 404, envelope("NOT_FOUND", `No mock data for ${path}`));
};
