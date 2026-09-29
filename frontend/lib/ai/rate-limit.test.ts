import { describe, expect, it } from "vitest";
import { createRateLimiter } from "@/lib/ai/rate-limit";

describe("createRateLimiter", () => {
  it("allows up to the limit inside a window, then blocks", () => {
    const now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
  });

  it("tracks keys independently", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
  });

  it("allows again once the window has passed", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    expect(limiter.allow("a")).toBe(true);
    now = 1001;
    expect(limiter.allow("a")).toBe(true);
  });

  it("forgets idle keys so memory stays bounded", () => {
    const now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 3, now: () => now });
    for (const key of ["a", "b", "c", "d", "e"]) limiter.allow(key);
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });
});
