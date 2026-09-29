import { isStepCount, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { generateBrief } from "@/lib/ai/generate-brief";
import { buildTemplateBrief } from "@/lib/ai/brief";
import { createMockModel } from "@/lib/ai/mock-model";
import { HEALTHY_DATA } from "@/lib/ai/quality";
import { createTools } from "@/lib/ai/tools";
import { mockSnapshot } from "@/lib/mock/scenarios";
import { MockLanguageModelV4 } from "ai/test";

const crisis = mockSnapshot("crisis");
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const textModel = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }),
  });

describe("generateBrief", () => {
  it("returns the model's brief marked as AI-written", async () => {
    const { headline, status, items } = buildTemplateBrief(crisis);
    const brief = await generateBrief(crisis, createMockModel({ brief: { headline, status, items } }));
    expect(brief).toMatchObject({ source: "ai", tick: 148, status: "critical" });
    expect(brief.items[0].title).toContain("Mirpur Fuel Station");
  });

  it("falls back to the rules brief when the model returns junk", async () => {
    const brief = await generateBrief(crisis, textModel("not json at all"));
    expect(brief).toEqual(buildTemplateBrief(crisis));
  });

  it("falls back when the model output breaks the schema", async () => {
    const brief = await generateBrief(crisis, textModel(JSON.stringify({ headline: "x", status: "panic", items: [] })));
    expect(brief.source).toBe("rules");
  });

  it("falls back when the model call throws", async () => {
    const broken = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("upstream 503");
      },
    });
    expect((await generateBrief(crisis, broken)).source).toBe("rules");
  });
});

describe("generateBrief safety floor", () => {
  const model = (content: object) => textModel(JSON.stringify(content));

  it("never lets the model downgrade a critical network to stable", async () => {
    const brief = await generateBrief(crisis, model({ headline: "All quiet", status: "stable", items: [] }));
    expect(brief.status).toBe("critical");
    expect(brief.headline).toBe(buildTemplateBrief(crisis).headline);
    expect(JSON.stringify(brief.items)).toContain("Mirpur Fuel Station");
    expect(brief.source).toBe("ai");
  });

  it("adds a high-severity problem the model left out, without duplicating ones it covered", async () => {
    const partial = {
      headline: "Mirpur is nearly out of diesel",
      status: "critical",
      items: [{ severity: "high", title: "Mirpur Fuel Station diesel critical", detail: "Only 14% left; the Gazipur Depot to Mirpur Fuel Station route is disrupted." }],
    };
    const brief = await generateBrief(crisis, model(partial));
    const text = JSON.stringify(brief.items);
    expect(text).toMatch(/failed/i); // the failed allocation was omitted, so it is appended
    expect(brief.items.filter((i) => /Mirpur Fuel Station.*(diesel|Diesel)/.test(i.title)).length).toBe(1);
  });

  it("raises a stable model brief when the data source is unhealthy", async () => {
    const quality = { stale: false, sourceHealthy: false, reason: "fuel simulator: no poll for 60s" };
    const stable = await generateBrief(mockSnapshot("crisis"), model({ headline: "Fine", status: "stable", items: [] }), quality);
    expect(stable.status).toBe("critical");
    expect(JSON.stringify(stable.items)).toMatch(/out of date/i);
  });
});

describe("mock model streaming", () => {
  it("calls a grounded tool and then answers from its result", async () => {
    const result = streamText({
      model: createMockModel(),
      messages: [{ role: "user", content: "Which stations are running low?" }],
      tools: createTools(async () => ({ snapshot: crisis, quality: HEALTHY_DATA })),
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
