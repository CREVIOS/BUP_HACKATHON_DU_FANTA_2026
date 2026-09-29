import type { AxiosInstance } from "axios";
import * as z from "zod/mini";
import { ApiError } from "@/lib/api/http";
import * as s from "@/lib/api/schemas";

type Schema<T> = z.ZodMiniType<T>;

function issues(error: z.core.$ZodError): string[] {
  return error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

function parseResponse<T>(schema: Schema<T>, data: unknown, path: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const details = issues(result.error);
  console.error("invalid API response", { path, details });
  throw new ApiError(200, "INVALID_RESPONSE", `Unexpected data from ${path}. It was not shown.`, details);
}

function validateBody<T>(schema: Schema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  throw new ApiError(0, "INVALID_REQUEST", "Please check the values you entered.", issues(result.error));
}

function idPath(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(0, "INVALID_REQUEST", "Invalid id.");
  return String(id);
}

// Every endpoint the UI uses, typed end to end: validated request in, validated response out.
export function createApi(http: AxiosInstance) {
  async function get<T>(path: string, schema: Schema<T>, signal?: AbortSignal, params?: Record<string, unknown>): Promise<T> {
    const response = await http.get(path, { signal, params });
    return parseResponse(schema, response.data, path);
  }

  async function post<B, T>(path: string, schema: Schema<T>, bodySchema?: Schema<B>, body?: unknown): Promise<T> {
    const payload = bodySchema ? validateBody(bodySchema, body ?? {}) : undefined;
    const response = await http.post(path, payload ?? null, { headers: { "Content-Type": "application/json" } });
    return parseResponse(schema, response.data, path);
  }

  async function put<B, T>(path: string, schema: Schema<T>, bodySchema: Schema<B>, body: unknown): Promise<T> {
    const response = await http.put(path, validateBody(bodySchema, body), { headers: { "Content-Type": "application/json" } });
    return parseResponse(schema, response.data, path);
  }

  return {
    // reads (viewer)
    overview: (signal?: AbortSignal) => get("/api/overview", s.overviewSchema, signal),
    status: (signal?: AbortSignal) => get("/api/status", s.statusSchema, signal),
    network: (signal?: AbortSignal) => get("/api/network", s.networkSchema, signal),
    risk: (signal?: AbortSignal) => get("/api/risk", s.riskSchema, signal),
    demand: (params: { station_id?: string; fuel_type?: string; ticks?: number; horizon?: number }, signal?: AbortSignal) =>
      get("/api/demand", s.demandSchema, signal, params),
    demandRegions: (params: { ticks?: number }, signal?: AbortSignal) =>
      get("/api/demand/regions", s.demandRegionsSchema, signal, params),
    supply: (signal?: AbortSignal) => get("/api/supply", s.supplySchema, signal),
    events: (signal?: AbortSignal) => get("/api/events", s.eventsSchema, signal),
    rl: (signal?: AbortSignal) => get("/api/rl", s.rlSchema, signal),
    rlShadow: (params: { limit?: number }, signal?: AbortSignal) => get("/api/rl/shadow", s.rlShadowSchema, signal, params),
    alerts: (params: { state?: "open" | "all"; limit?: number }, signal?: AbortSignal) =>
      get("/api/alerts", s.alertsSchema, signal, params),
    recommendations: (params: { status?: string; limit?: number } = {}, signal?: AbortSignal) =>
      get("/api/recommendations", s.recommendationsSchema, signal, params),
    recommendation: async (id: number, signal?: AbortSignal) =>
      get(`/api/recommendations/${idPath(id)}`, s.recommendationDetailSchema, signal),
    allocations: (signal?: AbortSignal) => get("/api/allocations", s.allocationsSchema, signal),
    decisions: (params: { limit?: number } = {}, signal?: AbortSignal) =>
      get("/api/decisions", s.decisionsSchema, signal, params),
    intelQuality: (signal?: AbortSignal) => get("/api/intel/quality", s.intelQualitySchema, signal),
    policy: (signal?: AbortSignal) => get("/api/policy", s.policySchema, signal),
    me: (signal?: AbortSignal) => get("/api/me", s.meSchema, signal),
    commands: (signal?: AbortSignal) => get("/api/admin/commands", s.commandsSchema, signal, { limit: 50 }),
    simulate: (body: s.SimulateBody) => post("/api/simulate", s.simulateResultSchema, s.simulateBodySchema, body),

    // operator
    approve: async (id: number, body: s.ApproveBody) =>
      post(`/api/recommendations/${idPath(id)}/approve`, s.recommendationSchema, s.approveBodySchema, body),
    reject: async (id: number, body: s.RejectBody) =>
      post(`/api/recommendations/${idPath(id)}/reject`, s.recommendationSchema, s.rejectBodySchema, body),
    ackAlert: async (id: number) => post(`/api/alerts/${idPath(id)}/ack`, s.ackResultSchema),
    allocate: (body: s.ManualAllocationBody) =>
      post("/api/allocations", s.recommendationSchema, s.manualAllocationBodySchema, body),
    cancelAllocation: async (id: number) => post(`/api/allocations/${idPath(id)}/cancel`, s.commandSchema),

    // admin
    step: (body: s.StepBody) => post("/api/admin/sim/step", s.commandSchema, s.stepBodySchema, body),
    run: () => post("/api/admin/sim/run", s.commandSchema),
    pause: () => post("/api/admin/sim/pause", s.commandSchema),
    reset: () => post("/api/admin/sim/reset", s.commandSchema),
    injectEvent: (body: s.EventBody) => post("/api/admin/sim/events", s.commandSchema, s.eventBodySchema, body),
    injectFault: (body: s.FaultBody) => post("/api/admin/sim/faults", s.commandSchema, s.faultBodySchema, body),
    clearFaults: () => post("/api/admin/sim/faults/clear", s.commandSchema),
    updatePolicy: (body: s.PolicyBody) => put("/api/policy", s.policySchema, s.policyBodySchema, body),
  };
}

export type Api = ReturnType<typeof createApi>;
