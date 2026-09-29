// TanStack Query keys. Prefix keys (…All) invalidate every parameterised variant.
export const keys = {
  overview: ["overview"],
  status: ["status"],
  network: ["network"],
  risk: ["risk"],
  demandAll: ["demand"],
  demand: (params: object) => ["demand", params],
  demandRegions: (params: object) => ["demand", "regions", params],
  supply: ["supply"],
  events: ["events"],
  alertsAll: ["alerts"],
  alerts: (params: object) => ["alerts", params],
  recommendationsAll: ["recommendations"],
  recommendations: (params: object) => ["recommendations", "list", params],
  recommendation: (id: number) => ["recommendations", "detail", id],
  allocations: ["allocations"],
  decisions: ["decisions"],
  intelQuality: ["intel-quality"],
  policy: ["policy"],
  me: ["me"],
  commands: ["commands"],
} as const;

export type QueryKey = readonly unknown[];
