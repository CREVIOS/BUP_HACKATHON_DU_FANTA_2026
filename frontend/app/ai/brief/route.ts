import { briefSchema, buildTemplateBrief, type BriefResponse } from "@/lib/ai/brief";
import { loadContext } from "@/lib/ai/backend";
import { generateBrief } from "@/lib/ai/generate-brief";
import { clientKey, json } from "@/lib/ai/http";
import { getModel } from "@/lib/ai/model";
import { createRateLimiter } from "@/lib/ai/rate-limit";
import { createTtlCache } from "@/lib/ai/ttl-cache";
import { isScenario } from "@/lib/mock/scenarios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The simulator can tick many times a second, so cache by time, not by tick: repeated page loads and
// several operators share one model call. ?refresh=1 (the refresh button) bypasses it.
const BRIEF_TTL_MS = 20_000;
const cache = createTtlCache<BriefResponse>({ ttlMs: BRIEF_TTL_MS });
const perClient = createRateLimiter({ limit: 12, windowMs: 60_000 });
const everyone = createRateLimiter({ limit: 60, windowMs: 60_000 }); // hard ceiling on model spend

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const param = url.searchParams.get("scenario");
  const scenario = isScenario(param) ? param : undefined;

  let loaded;
  try {
    loaded = await loadContext(scenario);
  } catch (error) {
    console.error("ai brief: cannot load state", { error: String(error) });
    return json({ error: "The operational data is unavailable." }, 502);
  }
  const { snapshot, quality } = loaded;

  const key = `${scenario ?? "live"}:${snapshot.instance.scenario_id}`;
  const hit = cache.get(key);
  if (hit && url.searchParams.get("refresh") !== "1") return json(hit);

  // Only a model call costs money, so only that is rate limited. Cache hits are free.
  if (!perClient.allow(clientKey(req)) || !everyone.allow("all")) {
    return hit ? json(hit) : json({ error: "Too many requests." }, 429);
  }

  // The mock model echoes the rules brief; a real model just ignores it.
  const template = briefSchema.safeParse(buildTemplateBrief(snapshot, quality));
  const { model, mock } = getModel({ brief: template.success ? template.data : undefined });
  const brief = await generateBrief(snapshot, model, quality);
  const response: BriefResponse = { ...brief, mock };
  cache.set(key, response);
  return json(response);
}
