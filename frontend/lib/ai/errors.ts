const GENERIC = "Something went wrong. Try again.";
const MAX_PLAIN_CHARS = 160;

// useChat surfaces a failed response as Error(body). Show the human sentence, not raw JSON.
export function friendlyError(error: Error): string {
  const message = error.message.trim();
  try {
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // not JSON: fall through to the plain-text rules
  }
  return message.length > 0 && message.length <= MAX_PLAIN_CHARS && !message.startsWith("{") ? message : GENERIC;
}
