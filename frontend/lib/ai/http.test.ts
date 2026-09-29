import { describe, expect, it } from "vitest";
import { clientKey } from "@/lib/ai/http";

const req = (headers: Record<string, string>) => new Request("http://localhost/ai/chat", { headers });

describe("clientKey", () => {
  it("falls back to a shared local key without a proxy header", () => {
    expect(clientKey(req({}))).toBe("local");
  });

  it("uses the entry the trusted proxy appended, not one the client can forge", () => {
    // The load balancer appends the real peer address to the right of what the client sent.
    expect(clientKey(req({ "x-forwarded-for": "1.2.3.4, 9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientKey(req({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("caps the key length", () => {
    expect(clientKey(req({ "x-forwarded-for": "x".repeat(500) })).length).toBeLessThanOrEqual(64);
  });
});
