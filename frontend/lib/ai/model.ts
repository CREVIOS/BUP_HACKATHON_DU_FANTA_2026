import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { BriefContent } from "@/lib/ai/brief";
import { createMockModel } from "@/lib/ai/mock-model";

const DEFAULT_MODEL_ID = "gpt-6-luna";

export interface ModelChoice {
  model: LanguageModel;
  mock: boolean;
}

// The one place that decides which LLM answers.
//   OPENAI_API_KEY   set      -> the real model
//   OPENAI_BASE_URL  optional -> an OpenAI-compatible gateway (read by @ai-sdk/openai)
//   LLM_MODEL        optional -> model id, defaults to gpt-6-luna
//   AI_MOCK=1                 -> force the mock even when a key is present
export function getModel(options: { brief?: BriefContent } = {}): ModelChoice {
  const key = process.env.OPENAI_API_KEY;
  if (process.env.AI_MOCK === "1" || !key) {
    return { model: createMockModel(options), mock: true };
  }
  return { model: openai(process.env.LLM_MODEL || DEFAULT_MODEL_ID), mock: false };
}
