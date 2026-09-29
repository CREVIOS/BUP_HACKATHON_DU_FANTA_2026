import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/http";
import { shouldRetry } from "@/lib/api/query-client";

describe("shouldRetry", () => {
  it("retries transient failures up to twice", () => {
    expect(shouldRetry(0, new ApiError(0, "NETWORK", "x"))).toBe(true);
    expect(shouldRetry(1, new ApiError(503, "HTTP_503", "x"))).toBe(true);
    expect(shouldRetry(2, new ApiError(503, "HTTP_503", "x"))).toBe(false);
    expect(shouldRetry(0, new ApiError(429, "RATE_LIMITED", "x"))).toBe(true);
  });

  it("never retries what a retry cannot fix", () => {
    expect(shouldRetry(0, new ApiError(422, "UNSAFE", "x"))).toBe(false);
    expect(shouldRetry(0, new ApiError(401, "UNAUTHORIZED", "x"))).toBe(false);
    expect(shouldRetry(0, new ApiError(200, "INVALID_RESPONSE", "x"))).toBe(false);
    expect(shouldRetry(0, new ApiError(409, "MOCK_READONLY", "x"))).toBe(false);
  });
});
