import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import type { Brief } from "@/lib/ai/brief";
import { BRIEF_INSTRUCTIONS, buildBriefPrompt, type BriefPromptInput } from "@/lib/ai/prompts";

// Reasoning models spend time on hidden reasoning before the structured answer, so the call needs more
// than a few seconds. On timeout the briefing simply shows without notes.
const BRIEF_TIMEOUT_MS = 18000;
const SUMMARY_MAX = 320;
const NOTE_MAX = 240;
const MAX_NOTES = 8;

// The model writes only this: a short summary and one note per problem id. Problems, figures, status and
// links are code's (lib/ai/brief), so the model can explain the situation but never hide or soften it.
export const notesSchema = z.object({
  summary: z.string().max(SUMMARY_MAX),
  notes: z.array(z.object({ id: z.string(), note: z.string().max(NOTE_MAX) })).max(MAX_NOTES),
});

export type ModelNotes = z.infer<typeof notesSchema>;

// What passed the grounding check, keyed by problem id.
export interface BriefNotes {
  summary?: string;
  notes: Record<string, string>;
}

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

export function numbersIn(text: string): Set<string> {
  return new Set((text.match(NUMBER) ?? []).map((n) => String(Number(n.replace(/,/g, "")))));
}

// Grounding guardrail: every figure the model writes must already be in what it was given.
export function grounded(text: string, allowed: ReadonlySet<string>): boolean {
  return [...numbersIn(text)].every((n) => allowed.has(n));
}

// Keep the notes that are about a real problem and quote only given figures; drop the rest one by one.
export function groundNotes(model: ModelNotes, prompt: string, ids: ReadonlySet<string>): BriefNotes | undefined {
  const allowed = numbersIn(prompt);
  const notes: Record<string, string> = {};
  for (const { id, note } of model.notes) {
    const text = note.trim();
    if (ids.has(id) && text && grounded(text, allowed)) notes[id] = text;
  }
  const text = model.summary.trim();
  const summary = text && grounded(text, allowed) ? text : undefined;
  return summary || Object.keys(notes).length > 0 ? { summary, notes } : undefined;
}

// Ask the model for the why and the what next. Any failure (timeout, bad output, provider error, nothing
// grounded) returns undefined, and the briefing shows without notes.
export async function generateNotes(input: BriefPromptInput, model: LanguageModel): Promise<BriefNotes | undefined> {
  const prompt = buildBriefPrompt(input);
  try {
    const { output } = await generateText({
      model,
      instructions: BRIEF_INSTRUCTIONS,
      prompt,
      output: Output.object({ schema: notesSchema }),
      timeout: BRIEF_TIMEOUT_MS,
      // Reasoning models (gpt-5.6+) pair a reasoning item with each message; scope
      // reasoning to this turn so the API does not demand earlier-turn reasoning
      // items the SDK didn't resend (the "message without its reasoning item" 400).
      providerOptions: { openai: { reasoningContext: "current_turn" } },
    });
    const parsed = notesSchema.safeParse(output);
    if (!parsed.success) throw new Error("model notes failed schema validation");
    return groundNotes(parsed.data, prompt, new Set(input.brief.items.map((i) => i.id)));
  } catch (error) {
    console.error("ai brief notes unavailable", { tick: input.snapshot.instance.tick, error: String(error) });
    return undefined;
  }
}

export function applyNotes(brief: Brief, notes: BriefNotes | undefined, notesTick: number): Brief {
  if (!notes) return brief;
  return {
    ...brief,
    summary: notes.summary,
    items: brief.items.map((item) => (notes.notes[item.id] ? { ...item, note: notes.notes[item.id] } : item)),
    source: "ai",
    notesTick,
  };
}
