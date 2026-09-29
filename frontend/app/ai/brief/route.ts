import { buildTemplateBrief, type Brief, type BriefResponse } from "@/lib/ai/brief";
import { listRecommendations, loadContext } from "@/lib/ai/backend";
import { briefSignature, createBriefHistory } from "@/lib/ai/brief-changes";
import { applyNotes, generateNotes, type BriefNotes } from "@/lib/ai/generate-brief";
import type { BriefPromptInput } from "@/lib/ai/prompts";
import { clientKey, json } from "@/lib/ai/http";
import { getModel } from "@/lib/ai/model";
import { createRateLimiter } from "@/lib/ai/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The figures are rebuilt from live data on every request and returned at once. The model writes its
// notes in the background (a reasoning model takes ~17 s) and the panel picks them up on its next ask.
// It is asked again only when the set of problems changes or its notes are old, and at most once per
// MIN_GAP_MS, so a busy simulator cannot turn into a stream of model calls.
const NOTES_MAX_AGE_MS = 5 * 60_000;
const MIN_GAP_MS = 30_000;
const PROPOSALS_READ = 50;

interface CachedNotes {
  signature: string;
  notes: BriefNotes;
  tick: number;
  at: number;
}

const history = createBriefHistory();
const notesCache = new Map<string, CachedNotes>();
const writing = new Set<string>(); // scenarios with a model call in flight: one at a time
const lastStart = new Map<string, number>();
const perClient = createRateLimiter({ limit: 12, windowMs: 60_000 });
const everyone = createRateLimiter({ limit: 60, windowMs: 60_000 }); // hard ceiling on model spend

function startNotes(key: string, signature: string, input: BriefPromptInput, model: Parameters<typeof generateNotes>[1]) {
  writing.add(key);
  lastStart.set(key, Date.now());
  void generateNotes(input, model)
    .then((notes) => {
      if (notes) notesCache.set(key, { signature, notes, tick: input.snapshot.instance.tick, at: Date.now() });
    })
    .finally(() => writing.delete(key));
}

// Notes written for this exact set of problems show in full. Older notes still show on the problems that
// are still open (each is labelled with the tick it was written at); their summary does not, since it may
// talk about something that has since cleared.
function present(brief: Brief, cached: CachedNotes | undefined, signature: string, pending: boolean): Brief {
  const notes = cached && (cached.signature === signature ? cached.notes : { notes: cached.notes.notes });
  const shown = cached ? applyNotes(brief, notes, cached.tick) : brief;
  return pending ? { ...shown, notesPending: true } : shown;
}

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
  const outdated = !cached || cached.signature !== signature || Date.now() - cached.at > NOTES_MAX_AGE_MS;
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const due = refresh || (outdated && Date.now() - (lastStart.get(key) ?? 0) > MIN_GAP_MS);
  // Only a model call costs money, so only starting one is rate limited.
  if (due && !writing.has(key) && perClient.allow(clientKey(req)) && everyone.allow("all")) {
    startNotes(key, signature, { snapshot, quality, brief, pending }, model);
  }
  return json(present(brief, cached, signature, writing.has(key)));
}
