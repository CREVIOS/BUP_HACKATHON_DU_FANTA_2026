"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useFuelopsContext } from "@/components/providers/fuelops-provider";
import type { Api } from "@/lib/api/client";
import { keys } from "@/lib/api/keys";

const STATUS_POLL_MS = 10_000; // /api/status is not on the stream (latency, error rate change continuously)

function useRead<T>(
  queryKey: QueryKey,
  read: (api: Api, signal: AbortSignal) => Promise<T>,
  options: { enabled?: boolean; pollMs?: number; keepPrevious?: boolean } = {},
) {
  const { api, pollMs } = useFuelopsContext();
  return useQuery({
    queryKey,
    queryFn: ({ signal }) => read(api, signal),
    refetchInterval: options.pollMs ?? pollMs,
    enabled: options.enabled ?? true,
    // Keep showing the previous result while a new key loads (e.g. the next tick's proposal).
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
  });
}

export const useApi = () => useFuelopsContext().api;
export const useStreamState = () => useFuelopsContext().stream;

export const useOverview = () => useRead(keys.overview, (api, signal) => api.overview(signal));
export const useStatus = () => useRead(keys.status, (api, signal) => api.status(signal), { pollMs: STATUS_POLL_MS });
export const useNetwork = () => useRead(keys.network, (api, signal) => api.network(signal));
export const useRisk = () => useRead(keys.risk, (api, signal) => api.risk(signal));
export const useSupply = () => useRead(keys.supply, (api, signal) => api.supply(signal));
export const useEvents = () => useRead(keys.events, (api, signal) => api.events(signal));
export const useAllocations = () => useRead(keys.allocations, (api, signal) => api.allocations(signal));
export const useIntelQuality = () => useRead(keys.intelQuality, (api, signal) => api.intelQuality(signal));
export const usePolicy = () => useRead(keys.policy, (api, signal) => api.policy(signal));
export const useMe = () => useRead(keys.me, (api, signal) => api.me(signal));
export const useRL = () => useRead(keys.rl, (api, signal) => api.rl(signal));
export const useRLShadow = (limit = 24) => useRead(keys.rlShadow({ limit }), (api, signal) => api.rlShadow({ limit }, signal));

export const useDecisions = (limit = 50) =>
  useRead([...keys.decisions, limit], (api, signal) => api.decisions({ limit }, signal));

export const useAlerts = (params: { state?: "open" | "all"; limit?: number } = {}) =>
  useRead(keys.alerts(params), (api, signal) => api.alerts(params, signal));

export const useRecommendations = (params: { status?: string; limit?: number } = {}) =>
  useRead(keys.recommendations(params), (api, signal) => api.recommendations(params, signal));

export const useRecommendation = (id: number | undefined) =>
  useRead(keys.recommendation(id ?? 0), (api, signal) => api.recommendation(id ?? 0, signal), {
    enabled: id !== undefined,
    keepPrevious: true,
  });

export const useDemand = (params: { station_id?: string; fuel_type?: string; ticks?: number; horizon?: number }) =>
  useRead(keys.demand(params), (api, signal) => api.demand(params, signal), { keepPrevious: true });

export const useDemandRegions = (params: { ticks?: number } = {}) =>
  useRead(keys.demandRegions(params), (api, signal) => api.demandRegions(params, signal));

export const useCommands = (enabled: boolean) =>
  useRead(keys.commands, (api, signal) => api.commands(signal), { enabled });

// A write, then refresh what it changed (the stream would too, this is just faster on this replica).
function useAction<V, R>(run: (api: Api, vars: V) => Promise<R>, refresh: readonly QueryKey[]) {
  const { api } = useFuelopsContext();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: V) => run(api, vars),
    onSettled: () => Promise.all(refresh.map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  });
}

const DECISION_KEYS = [keys.recommendationsAll, keys.decisions, keys.overview, keys.allocations, keys.alertsAll];
const WORLD_KEYS = [keys.overview, keys.network, keys.risk, keys.events, keys.supply, keys.allocations, keys.alertsAll, keys.recommendationsAll, keys.commands, keys.demandAll];

export const useApprove = () =>
  useAction((api, v: { id: number; reason?: string; quantity?: number }) => api.approve(v.id, { reason: v.reason, quantity: v.quantity }), DECISION_KEYS);
export const useReject = () => useAction((api, v: { id: number; reason: string }) => api.reject(v.id, { reason: v.reason }), DECISION_KEYS);
export const useAckAlert = () => useAction((api, id: number) => api.ackAlert(id), [keys.alertsAll, keys.overview]);
export const useSimulate = () => useAction((api, body: Parameters<Api["simulate"]>[0]) => api.simulate(body), []);
export const useAllocate = () => useAction((api, body: Parameters<Api["allocate"]>[0]) => api.allocate(body), DECISION_KEYS);
export const useCancelAllocation = () => useAction((api, id: number) => api.cancelAllocation(id), [keys.allocations, keys.network]);

export const useStep = () => useAction((api, count: number) => api.step({ count }), WORLD_KEYS);
export const useRun = () => useAction((api) => api.run(), WORLD_KEYS);
export const usePause = () => useAction((api) => api.pause(), WORLD_KEYS);
export const useReset = () => useAction((api) => api.reset(), WORLD_KEYS);
export const useInjectEvent = () => useAction((api, body: Parameters<Api["injectEvent"]>[0]) => api.injectEvent(body), WORLD_KEYS);
export const useInjectFault = () => useAction((api, body: Parameters<Api["injectFault"]>[0]) => api.injectFault(body), [keys.status, keys.commands, keys.overview]);
export const useClearFaults = () => useAction((api) => api.clearFaults(), [keys.status, keys.commands, keys.overview]);
export const useUpdatePolicy = () => useAction((api, body: Parameters<Api["updatePolicy"]>[0]) => api.updatePolicy(body), [keys.policy, keys.overview]);
