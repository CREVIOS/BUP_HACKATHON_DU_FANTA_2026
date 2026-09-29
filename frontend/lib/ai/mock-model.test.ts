import { isStepCount, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { createMockModel } from "@/lib/ai/mock-model";
import { HEALTHY_DATA } from "@/lib/ai/quality";
import { createTools } from "@/lib/ai/tools";
import { crisisSnapshot } from "@/lib/mock/scenarios";

const ask = (question: string, load: Parameters<typeof createTools>[0]) =>
  streamText({
    model: createMockModel({ chunkDelayMs: 0 }),
    messages: [{ role: "user", content: question }],
    tools: createTools(load),
    stopWhen: isStepCount(4),
  });

describe("mock model", () => {
  const crisis = async () => ({ snapshot: crisisSnapshot(), quality: HEALTHY_DATA });

  it.each([
    ["Any disrupted routes?", "getRoutes", "disrupted"],
    ["What events are active?", "getEvents", "Route disruption"],
    ["Show recent allocations", "getAllocations", "#44"],
    ["What is happening right now?", "getOverview", "Tick 148"],
  ])("routes %j to %s and narrates its result", async (question, tool, expected) => {
    const result = ask(question, crisis);
    const steps = await result.steps;
    expect(steps[0].toolCalls.map((c) => c.toolName)).toEqual([tool]);
    expect(await result.text).toContain(expected);
  });

  it("says it could not read the data when the tool fails, instead of inventing numbers", async () => {
    const result = ask("Which stations are running low?", async () => {
      throw new Error("API /api/state returned 500");
    });
    const text = await result.text;
    expect(text).toMatch(/could not read/i);
    expect(text).not.toMatch(/undefined|\d+%/);
  });
});
