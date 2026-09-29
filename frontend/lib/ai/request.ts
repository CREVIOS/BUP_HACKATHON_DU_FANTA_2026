import { safeValidateUIMessages, type UIMessage } from "ai";
import { isScenario, type Scenario } from "@/lib/mock/scenarios";

export const MAX_MESSAGES = 30;
export const MAX_TEXT_CHARS = 2000; // per user message
export const MAX_HISTORY_CHARS = 20_000; // whole conversation, assistant text included

export type ChatRequest =
  | { ok: true; messages: UIMessage[]; scenario: Scenario | undefined }
  | { ok: false; error: string };

const fail = (error: string): ChatRequest => ({ ok: false, error });

function textLength(message: UIMessage): number {
  return message.parts.reduce((n, part) => (part.type === "text" ? n + part.text.length : n), 0);
}

// Only text is trusted from the browser. Tool calls and results are dropped: the server-side tools
// produce the real ones, and a forged "tool result" must never look like our data to the model.
//
// We also rebuild each part and the message from scratch, dropping provider metadata. That metadata
// carries OpenAI Responses item ids (msg_/rs_) for reasoning models; replaying an assistant message
// item without its paired reasoning item makes the API 400 ("message ... without its required
// 'reasoning' item"). Sending prior turns as plain text avoids that and is safer besides.
function textOnly(message: UIMessage): UIMessage | undefined {
  const parts = message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => ({ type: "text" as const, text: part.text }));
  if (parts.length === 0) return undefined;
  return { id: message.id, role: message.role, parts };
}

// Validate everything from the browser before it reaches the model.
export async function parseChatRequest(body: unknown): Promise<ChatRequest> {
  if (typeof body !== "object" || body === null) return fail("Request body must be a JSON object.");
  const { messages, scenario } = body as { messages?: unknown; scenario?: unknown };

  if (!Array.isArray(messages) || messages.length === 0) return fail("messages must be a non-empty array.");
  if (messages.length > MAX_MESSAGES) return fail(`At most ${MAX_MESSAGES} messages are accepted.`);

  const validated = await safeValidateUIMessages({ messages });
  if (!validated.success) return fail("messages are malformed.");

  const cleaned = validated.data.flatMap((m) => {
    const kept = textOnly(m);
    return kept ? [kept] : [];
  });
  if (cleaned.length === 0) return fail("messages contain no text.");
  if (cleaned.some((m) => m.role === "user" && textLength(m) > MAX_TEXT_CHARS)) {
    return fail(`Each message is limited to ${MAX_TEXT_CHARS} characters.`);
  }
  if (cleaned.reduce((n, m) => n + textLength(m), 0) > MAX_HISTORY_CHARS) {
    return fail("The conversation is too long. Start a new one.");
  }
  return { ok: true, messages: cleaned, scenario: isScenario(scenario) ? scenario : undefined };
}
