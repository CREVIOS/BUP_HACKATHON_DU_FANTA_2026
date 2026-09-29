import { describe, expect, it } from "vitest";
import { friendlyError } from "@/lib/ai/errors";

describe("friendlyError", () => {
  it("unwraps the JSON error body the /ai routes return", () => {
    expect(friendlyError(new Error('{"error":"Too many requests. Try again in a minute."}'))).toBe("Too many requests. Try again in a minute.");
  });

  it("keeps a short plain message from the stream", () => {
    expect(friendlyError(new Error("The assistant is unavailable right now."))).toBe("The assistant is unavailable right now.");
  });

  it("hides long or unexpected text behind a generic message", () => {
    expect(friendlyError(new Error("x".repeat(400)))).toBe("Something went wrong. Try again.");
    expect(friendlyError(new Error(""))).toBe("Something went wrong. Try again.");
  });
});
