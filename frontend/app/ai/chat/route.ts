import { convertToModelMessages, createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream } from "ai";
import { explainRecommendation, listRecommendations, loadContext } from "@/lib/ai/backend";
import { clientKey, json } from "@/lib/ai/http";
import { getModel } from "@/lib/ai/model";
import { CHAT_INSTRUCTIONS } from "@/lib/ai/prompts";
import { createRateLimiter } from "@/lib/ai/rate-limit";
import { parseChatRequest } from "@/lib/ai/request";
import { createTools } from "@/lib/ai/tools";

// Lives under /ai, not /api: the load balancer sends /api straight to the Go API.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHAT_TIMEOUT_MS = 30_000;
const MAX_TOOL_STEPS = 5;
const MAX_BODY_BYTES = 64 * 1024;
const perClient = createRateLimiter({ limit: 20, windowMs: 60_000 });
const everyone = createRateLimiter({ limit: 120, windowMs: 60_000 }); // hard ceiling on model spend

export async function POST(req: Request): Promise<Response> {
  if (!perClient.allow(clientKey(req)) || !everyone.allow("all")) {
    return json({ error: "Too many requests. Try again in a minute." }, 429);
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return json({ error: "Request is too large." }, 413);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }
  const parsed = await parseChatRequest(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const { model } = getModel();
  const result = streamText({
    model,
    instructions: CHAT_INSTRUCTIONS,
    messages: await convertToModelMessages(parsed.messages),
    tools: createTools({
      load: () => loadContext(),
      listRecommendations: (opts) => listRecommendations(opts),
      explainRecommendation: (id) => explainRecommendation(id),
    }),
    stopWhen: isStepCount(MAX_TOOL_STEPS),
    timeout: CHAT_TIMEOUT_MS,
    abortSignal: req.signal, // Stop or a closed tab cancels the model call
    // Reasoning models (gpt-5.6+) pair a reasoning item with each message. The
    // browser replays history without those items, so scope reasoning to the
    // current turn to avoid the "message without its reasoning item" 400.
    providerOptions: { openai: { reasoningContext: "current_turn" } },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      // Details go to the server log; the browser only gets a generic message.
      onError: (error) => {
        console.error("ai chat stream error", { error: String(error) });
        return "The assistant is unavailable right now. The data on this page is unaffected.";
      },
    }),
  });
}
