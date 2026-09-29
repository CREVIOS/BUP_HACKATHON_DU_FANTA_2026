import { describe, expect, it, vi } from "vitest";
import type { DecisionExplanation, RecommendationSummary } from "@/lib/ai/backend";
import { createTools } from "@/lib/ai/tools";

const explanation: DecisionExplanation = {
  headline: "Ship 5,000 L diesel to STN-MIRPUR from DEP-GAZIPUR — stockout risk 72%→5%",
  narrative: "Routine top-up.",
  factors: ["stockout risk 72% before shipment"],
  confidence: "high",
  action: "Safe to auto-dispatch",
  source: "llm",
};

const recs: RecommendationSummary[] = [
  { id: 12, station_id: "station-mirpur", fuel_type: "diesel", quantity: 5000, verdict: "review", status: "PROPOSED", risk_before: 0.72, risk_after: 0.31 },
];

// A context whose backend calls are spies; load is never used by these tools.
function ctx() {
  return {
    load: vi.fn(),
    listRecommendations: vi.fn(async () => recs),
    explainRecommendation: vi.fn(async (_id: number) => explanation),
  };
}

// The AI SDK tool.execute takes (input, options); our tools ignore options.
const opts = {} as never;

describe("createTools", () => {
  it("exposes the recommendation tools alongside the read tools", () => {
    const tools = createTools(ctx());
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["getOverview", "listRecommendations", "explainRecommendation"]),
    );
  });

  it("listRecommendations passes status/limit through to the backend", async () => {
    const c = ctx();
    const tools = createTools(c);
    const out = await tools.listRecommendations.execute!({ status: "PROPOSED", limit: 5 }, opts);
    expect(c.listRecommendations).toHaveBeenCalledWith({ status: "PROPOSED", limit: 5 });
    expect(out).toEqual({ recommendations: recs });
  });

  it("explainRecommendation returns the backend explanation verbatim", async () => {
    const c = ctx();
    const tools = createTools(c);
    const out = await tools.explainRecommendation.execute!({ id: 12 }, opts);
    expect(c.explainRecommendation).toHaveBeenCalledWith(12);
    expect(out).toEqual(explanation);
  });

  it("surfaces a backend failure as a rejected tool call (the route turns it into a message)", async () => {
    const c = ctx();
    c.explainRecommendation.mockRejectedValueOnce(new Error("API returned 404"));
    const tools = createTools(c);
    await expect(tools.explainRecommendation.execute!({ id: 99 }, opts)).rejects.toThrow(/404/);
  });
});
