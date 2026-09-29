import { generateText, Output, type LanguageModel } from "ai";
import {
  briefSchema,
  buildTemplateBrief,
  bySeverity,
  findings,
  MAX_ITEMS,
  toItem,
  worseStatus,
  type Brief,
  type BriefContent,
} from "@/lib/ai/brief";
import { BRIEF_INSTRUCTIONS, buildBriefPrompt } from "@/lib/ai/prompts";
import { HEALTHY_DATA, type DataQuality } from "@/lib/ai/quality";
import type { Snapshot } from "@/lib/types";

const BRIEF_TIMEOUT_MS = 8000;

// The model may reword and prioritise, but it may never make things look better than the data:
// status cannot drop below what code computed, and any high-severity problem it left out is added back.
function enforceFloor(model: BriefContent, snapshot: Snapshot, quality: DataQuality, floor: Brief): BriefContent {
  const written = `${model.headline} ${JSON.stringify(model.items)}`.toLowerCase();
  const omitted = findings(snapshot, quality)
    .filter((f) => f.severity === "high" && !f.subjects.some((subject) => written.includes(subject)))
    .map(toItem);

  const status = worseStatus(model.status, floor.status);
  const downgraded = status !== model.status || omitted.length > 0;
  return {
    headline: downgraded ? floor.headline : model.headline,
    status,
    items: bySeverity([...omitted, ...model.items]).slice(0, MAX_ITEMS),
  };
}

// Ask the model to narrate the facts. Any failure (timeout, bad output, provider error) degrades to
// the deterministic rules brief, so the panel never goes blank (brief section 11).
export async function generateBrief(
  snapshot: Snapshot,
  model: LanguageModel,
  quality: DataQuality = HEALTHY_DATA,
): Promise<Brief> {
  const floor = buildTemplateBrief(snapshot, quality);
  try {
    const { output } = await generateText({
      model,
      instructions: BRIEF_INSTRUCTIONS,
      prompt: buildBriefPrompt(snapshot, quality),
      output: Output.object({ schema: briefSchema }),
      timeout: BRIEF_TIMEOUT_MS,
    });
    const parsed = briefSchema.safeParse(output);
    if (!parsed.success) throw new Error("model brief failed schema validation");
    return { ...enforceFloor(parsed.data, snapshot, quality, floor), source: "ai", tick: snapshot.instance.tick };
  } catch (error) {
    console.error("ai brief fell back to rules", { tick: snapshot.instance.tick, error: String(error) });
    return floor;
  }
}
