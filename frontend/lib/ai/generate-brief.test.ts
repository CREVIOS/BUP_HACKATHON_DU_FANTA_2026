import { isStepCount, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { applyNotes, generateNotes } from "@/lib/ai/generate-brief";
import { buildTemplateBrief } from "@/lib/ai/brief";
import { createMockModel } from "@/lib/ai/mock-model";
import { HEALTHY_DATA } from "@/lib/ai/quality";
import { createTools } from "@/lib/ai/tools";
import { crisisSnapshot } from "@/lib/mock/scenarios";
import { MockLanguageModelV4 } from "ai/test";

const crisis = crisisSnapshot();
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const textModel = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }),
  });

describe("generateNotes", () => {
  const brief = buildTemplateBrief(crisis);
  const input = { snapshot: crisis, brief };
  const notes = (content: object) => textModel(JSON.stringify(content));

  it("keeps notes that quote only given figures and marks the briefing as AI", async () => {
    const result = await generateNotes(input, createMockModel({ notes: { summary: "Mirpur Fuel Station is the priority: diesel is at 14%.", notes: [{ id: "routes", note: "Mirpur relies on Gazipur Depot; check the route in Network." }] } }));
    expect(result).toEqual({ summary: "Mirpur Fuel Station is the priority: diesel is at 14%.", notes: { routes: "Mirpur relies on Gazipur Depot; check the route in Network." } });
    const shown = applyNotes(brief, result, 148);
    expect(shown).toMatchObject({ source: "ai", notesTick: 148, status: brief.status, headline: brief.headline });
    expect(shown.items.find((i) => i.id === "routes")?.note).toContain("Gazipur Depot");
    expect(shown.items.map((i) => i.title)).toEqual(brief.items.map((i) => i.title));
  });

  it("drops a note with a number that is not in the data, and notes for unknown problems", async () => {
    const result = await generateNotes(input, notes({ summary: "Expect 9,999 L to go unmet.", notes: [{ id: "routes", note: "Reroute 7,777 L." }, { id: "made-up", note: "Nothing." }, { id: "failed", note: "Retry the failed allocation." }] }));
    expect(result).toEqual({ summary: undefined, notes: { failed: "Retry the failed allocation." } });
  });

  it("returns nothing when the model returns junk, breaks the schema or throws", async () => {
    expect(await generateNotes(input, textModel("not json at all"))).toBeUndefined();
    expect(await generateNotes(input, notes({ summary: 3, notes: "none" }))).toBeUndefined();
    const broken = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("upstream 503");
      },
    });
    expect(await generateNotes(input, broken)).toBeUndefined();
    expect(applyNotes(brief, undefined, 148)).toEqual(brief);
  });
});

describe("mock model streaming", () => {
  it("calls a grounded tool and then answers from its result", async () => {
    const result = streamText({
      model: createMockModel(),
      messages: [{ role: "user", content: "Which stations are running low?" }],
      tools: createTools({
        load: async () => ({ snapshot: crisis, quality: HEALTHY_DATA }),
        listRecommendations: async () => [],
        explainRecommendation: async () => {
          throw new Error("not used in this test");
        },
      }),
      stopWhen: isStepCount(4),
    });
    const text = await result.text;
    const steps = await result.steps;
    expect(steps).toHaveLength(2);
    expect(steps[0].toolCalls.map((c) => c.toolName)).toEqual(["getLowStock"]);
    expect(text).toContain("Mirpur Fuel Station");
    expect(text).toContain("14%");
  });
});
