import { describe, expect, it } from "vitest";
import { createTtlCache } from "@/lib/ai/ttl-cache";

describe("createTtlCache", () => {
  it("returns a value within its ttl and drops it after", () => {
    let now = 0;
    const cache = createTtlCache<string>({ ttlMs: 1000, now: () => now });
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
    now = 999;
    expect(cache.get("k")).toBe("v");
    now = 1000;
    expect(cache.get("k")).toBeUndefined();
  });

  it("evicts the oldest entry beyond maxEntries", () => {
    const cache = createTtlCache<number>({ ttlMs: 1000, maxEntries: 2, now: () => 0 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("overwriting refreshes the timestamp", () => {
    let now = 0;
    const cache = createTtlCache<string>({ ttlMs: 1000, now: () => now });
    cache.set("k", "old");
    now = 900;
    cache.set("k", "new");
    now = 1500;
    expect(cache.get("k")).toBe("new");
  });
});
