import { buildTemplateBrief, type BriefResponse } from "@/lib/ai/brief";
import { loadContext } from "@/lib/ai/backend";
import { generateBrief } from "@/lib/ai/generate-brief";
import { clientKey, json } from "@/lib/ai/http";
import { getModel } from "@/lib/ai/model";
import { createRateLimiter } from "@/lib/ai/rate-limit";
import { createTtlCache } from "@/lib/ai/ttl-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The simulator can tick many times a second, so cache by time, not by tick: repeated page loads and
// several operators share one model call. ?refresh=1 (the refresh button) bypasses it.
const BRIEF_TTL_MS = 20_000;
const cache = createTtlCache<BriefResponse>({ ttlMs: BRIEF_TTL_MS });
const perClient = createRateLimiter({ limit: 12, windowMs: 60_000 });
const everyone = createRateLimiter({ limit: 60, windowMs: 60_000 }); // hard ceiling on model spend

export async function GET(req: Request): Promise<Response> {
  let loaded;
  try {
    loaded = await loadContext();
  } catch (error) {
    console.error("ai brief: cannot load state", { error: String(error) });
    return json({ error: "The operational data is unavailable." }, 502);
  }
  const { snapshot, quality } = loaded;

  // Without a language model the briefing is the rules brief itself: no cache or rate limit needed.
  const { model, mock } = getModel();
  if (mock) return json(buildTemplateBrief(snapshot, quality) satisfies BriefResponse);

  const key = snapshot.instance.scenario_id;
  const hit = cache.get(key);
  if (hit && new URL(req.url).searchParams.get("refresh") !== "1") return json(hit);

  // Only a model call costs money, so only that is rate limited. Cache hits are free.
  if (!perClient.allow(clientKey(req)) || !everyone.allow("all")) {
    return hit ? json(hit) : json({ error: "Too many requests." }, 429);
  }

  const brief = await generateBrief(snapshot, model, quality);
  cache.set(key, brief);
  return json(brief);
}
