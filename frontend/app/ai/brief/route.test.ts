import { describe, expect, it, vi } from "vitest";

// A model that answers only when the test opens the gate, like a slow reasoning model.
const gate = vi.hoisted(() => {
  let open = () => {};
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { ready, open: () => open() };
});

vi.mock("@/lib/ai/backend", async () => {
  const { crisisSnapshot } = await import("@/lib/mock/scenarios");
  const { HEALTHY_DATA } = await import("@/lib/ai/quality");
  return { loadContext: async () => ({ snapshot: crisisSnapshot(), quality: HEALTHY_DATA }), listRecommendations: async () => [] };
});

vi.mock("@/lib/ai/model", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      await gate.ready;
      const text = JSON.stringify({ summary: "Mirpur Fuel Station is the priority.", notes: [] });
      return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
    },
  });
  return { getModel: () => ({ model, mock: false }) };
});

describe("GET /ai/brief", () => {
  it("answers at once while the model writes, then serves its notes", async () => {
    const { GET } = await import("./route");
    const ask = async () => (await GET(new Request("http://localhost/ai/brief"))).json();

    expect(await ask()).toMatchObject({ source: "rules", status: "critical", notesPending: true });
    gate.open();
    await vi.waitFor(async () => {
      const next = await ask();
      expect(next).toMatchObject({ source: "ai", summary: "Mirpur Fuel Station is the priority.", notesTick: 148 });
      expect(next.notesPending).toBeUndefined();
    });
  });
});
