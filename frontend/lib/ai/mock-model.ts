// Deterministic stand-in for the real LLM, used when no OPENAI_API_KEY is set (and in tests).
// It exercises the whole pipeline: it picks a tool from the question, then narrates that tool's
// result. It never invents numbers: every figure comes from the tool output it is handed.
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { BriefContent } from "@/lib/ai/brief";
import { formatNumber, humanize } from "@/lib/format";

type Prompt = Parameters<MockLanguageModelV4["doStream"]>[0]["prompt"];

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
};
const finish = (unified: "stop" | "tool-calls") => ({
  type: "finish" as const,
  finishReason: { unified, raw: undefined },
  usage,
});

const STABLE_BRIEF: BriefContent = { headline: "Network stable", status: "stable", items: [] };

function lastUserText(prompt: Prompt): string {
  for (const message of [...prompt].reverse()) {
    if (message.role === "user") {
      return message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
    }
  }
  return "";
}

function pickTool(question: string): { toolName: string; args: Record<string, unknown> } {
  const q = question.toLowerCase();
  if (/route|disrupt|transit|road/.test(q)) return { toolName: "getRoutes", args: {} };
  if (/event|spike|surge/.test(q)) return { toolName: "getEvents", args: {} };
  if (/allocation|shipment|dispatch|deliver/.test(q)) return { toolName: "getAllocations", args: {} };
  if (/stock|low|inventory|diesel|petrol|octane|run out|shortage|fuel|risk|why/.test(q)) {
    return { toolName: "getLowStock", args: { maxPercent: 40 } };
  }
  return { toolName: "getOverview", args: {} };
}

interface StockRow { name: string; fuel: string; inventory: number; capacity: number; percent: number }

function describeStock(row: StockRow): string {
  return `${row.name} ${humanize(row.fuel).toLowerCase()} at ${row.percent}% (${formatNumber(row.inventory)} L of ${formatNumber(row.capacity)} L)`;
}

function narrate(toolName: string, output: unknown): string {
  const o = (output ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "getLowStock": {
      const entries = (o.entries as StockRow[] | undefined) ?? [];
      if (entries.length === 0) return `Nothing is at or below ${String(o.maxPercent ?? 40)}% of capacity right now.`;
      const rest = entries.slice(1, 3).map((e) => `${e.name} ${humanize(e.fuel).toLowerCase()} ${e.percent}%`);
      return `${entries.length} fuel levels are at or below ${String(o.maxPercent)}% of capacity. Lowest: ${describeStock(entries[0])}.${rest.length ? ` Next: ${rest.join(", ")}.` : ""}`;
    }
    case "getRoutes": {
      const routes = (o.routes as { from: string; to: string; status: string }[] | undefined) ?? [];
      const down = routes.filter((r) => r.status === "DISRUPTED");
      if (routes.length === 0) return "No routes were returned.";
      return down.length === 0
        ? `All ${routes.length} routes are available.`
        : `${down.length} of ${routes.length} routes are disrupted: ${down.map((r) => `${r.from} to ${r.to}`).join("; ")}.`;
    }
    case "getEvents": {
      const events = (o.events as { type: string; status: string; endTick: number }[] | undefined) ?? [];
      return events.length === 0
        ? "There are no events."
        : `${events.length} events: ${events.map((e) => `${humanize(e.type)} (${e.status.toLowerCase()}, until tick ${e.endTick})`).join("; ")}.`;
    }
    case "getAllocations": {
      const list = (o.allocations as { id: number; from: string; to: string; fuel: string; quantity: number; status: string }[] | undefined) ?? [];
      if (list.length === 0) return "There are no allocations yet.";
      const latest = list[0];
      return `${list.length} recent allocations. Newest: #${latest.id}, ${formatNumber(latest.quantity)} L ${humanize(latest.fuel).toLowerCase()} from ${latest.from} to ${latest.to}, ${latest.status.toLowerCase().replace("_", " ")}.`;
    }
    case "getStock": {
      const entries = (o.entries as StockRow[] | undefined) ?? [];
      return entries.length === 0 ? "No such depot or station." : entries.map(describeStock).join("; ") + ".";
    }
    default: {
      const routes = (o.disruptedRoutes as unknown[] | undefined)?.length ?? 0;
      const events = (o.activeEvents as unknown[] | undefined)?.length ?? 0;
      const level = typeof o.serviceLevel === "number" ? `${(o.serviceLevel * 100).toFixed(1)}%` : "unknown";
      return `Tick ${String(o.tick)}, ${String(o.runState ?? "").toLowerCase()}. Service level ${level}, ${formatNumber(o.unmetLiters as number | undefined)} L unmet. ${routes} disrupted routes, ${events} active events.`;
    }
  }
}

function words(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

export function createMockModel(options: { brief?: BriefContent; chunkDelayMs?: number } = {}) {
  const { brief = STABLE_BRIEF, chunkDelayMs = 25 } = options;
  let calls = 0;

  return new MockLanguageModelV4({
    modelId: "fuelops-mock",
    provider: "mock",
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(brief) }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
    doStream: async ({ prompt }) => {
      const last = prompt[prompt.length - 1];
      const toolResults = last?.role === "tool" ? last.content.filter((p) => p.type === "tool-result") : [];

      if (toolResults.length === 0) {
        const { toolName, args } = pickTool(lastUserText(prompt));
        calls += 1;
        return {
          stream: simulateReadableStream({
            chunkDelayInMs: chunkDelayMs,
            chunks: [
              { type: "tool-call" as const, toolCallId: `mock-call-${calls}`, toolName, input: JSON.stringify(args) },
              finish("tool-calls"),
            ],
          }),
        };
      }

      // A failed lookup must never read as "all clear": say the data could not be read.
      const unreadable = toolResults.some((r) => r.output.type !== "json");
      const answer = unreadable
        ? "I could not read the network data right now, so I cannot answer that. Try again in a moment."
        : toolResults.map((r) => narrate(r.toolName, r.output.type === "json" ? r.output.value : undefined)).join(" ");
      return {
        stream: simulateReadableStream({
          chunkDelayInMs: chunkDelayMs,
          chunks: [
            { type: "text-start" as const, id: "mock-text" },
            ...words(answer).map((delta) => ({ type: "text-delta" as const, id: "mock-text", delta })),
            { type: "text-end" as const, id: "mock-text" },
            finish("stop"),
          ],
        }),
      };
    },
  });
}
