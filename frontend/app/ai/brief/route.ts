import { buildTemplateBrief, type Brief, type BriefResponse } from "@/lib/ai/brief";
import { listRecommendations, loadContext } from "@/lib/ai/backend";
import { briefSignature, createBriefHistory } from "@/lib/ai/brief-changes";
import { applyNotes, generateNotes, type BriefNotes } from "@/lib/ai/generate-brief";
import { clientKey, json } from "@/lib/ai/http";
import { getModel } from "@/lib/ai/model";
import { createRateLimiter } from "@/lib/ai/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The figures are rebuilt from live data on every request (cheap). The model is asked again only when
// the set of problems changes, or when its notes are older than this, so a steady network costs no calls
// and the text does not churn while the operator reads it.
const NOTES_MAX_AGE_MS = 5 * 60_000;
const PROPOSALS_READ = 50;

interface CachedNotes {
  signature: string;
  notes: BriefNotes;
  tick: number;
  at: number;
}

const history = createBriefHistory();
const notesCache = new Map<string, CachedNotes>();
const inflight = new Map<string, Promise<BriefNotes | undefined>>(); // one model call per state, however many viewers
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
  // Proposals only add the review item and links; the briefing still works without them.
  const pending = await listRecommendations({ status: "PROPOSED", limit: PROPOSALS_READ }).catch((error: unknown) => {
    console.warn("ai brief: proposals unavailable", { error: String(error) });
    return [];
  });

  const key = snapshot.instance.scenario_id;
  const base = buildTemplateBrief(snapshot, quality, pending);
  const brief: Brief = { ...base, changes: history.track(key, base) };

  // Without a language model the briefing is the computed one: no notes, no model spend.
  const { model, mock } = getModel();
  if (mock) return json(brief satisfies BriefResponse);

  const signature = briefSignature(brief);
  const cached = notesCache.get(key);
  const current = cached?.signature === signature ? cached : undefined;
  const withCached = () => json(current ? applyNotes(brief, current.notes, current.tick) : brief);
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  if (current && !refresh && Date.now() - current.at < NOTES_MAX_AGE_MS) return withCached();

  // Only a model call costs money, so only that is rate limited.
  if (!perClient.allow(clientKey(req)) || !everyone.allow("all")) return withCached();

  const flight = `${key}|${signature}`;
  let call = inflight.get(flight);
  if (!call) {
    call = generateNotes({ snapshot, quality, brief, pending }, model).finally(() => inflight.delete(flight));
    inflight.set(flight, call);
  }
  const notes = await call;
  if (!notes) return withCached();
  notesCache.set(key, { signature, notes, tick: brief.tick, at: Date.now() });
  return json(applyNotes(brief, notes, brief.tick));
}
