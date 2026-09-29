// Client-safe labels for tool calls shown in the chat ("Data used").
export const TOOL_LABELS: Record<string, string> = {
  getOverview: "Network overview",
  getLowStock: "Low stock",
  getStock: "Stock levels",
  getRoutes: "Routes",
  getEvents: "Events",
  getAllocations: "Allocations",
  listRecommendations: "Recommendations",
  explainRecommendation: "Decision explanation",
};

export const toolLabel = (name: string): string => TOOL_LABELS[name] ?? name;
