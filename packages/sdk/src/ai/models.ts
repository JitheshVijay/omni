// Centralized model registry. One place to change what model each
// surface uses. Everything routes through OpenRouter (OPENROUTER_API_KEY).
//
// Model id shape is "<provider>/<model>" — OpenRouter's convention. The
// :online suffix (e.g. "anthropic/claude-haiku-4-5:online") tells
// OpenRouter to wrap the model with their web-search plugin.

export const MODELS = {
  // Super Agent loop (P3). Needs strong tool-calling + vision + long
  // context; Sonnet 5 is the same tier as the chat default.
  agent: "anthropic/claude-sonnet-5",

  // Default for callLLM/callLLMJSON and new chat threads when the user
  // hasn't picked a model.
  default: "anthropic/claude-sonnet-5",

  // Cheap / fast model for lightweight tasks: thread titles, compaction
  // summaries, transcription cleanup.
  cheap: "anthropic/claude-haiku-4-5",

  // Web-search variant — :online appends OpenRouter's search plugin.
  cheap_online: "anthropic/claude-haiku-4-5:online",

  // Embeddings for hub memory (1536-dim). OpenRouter proxies OpenAI's
  // text-embedding-3-small; the vec_hub_memory index is sized to match.
  embedding: "openai/text-embedding-3-small",

  // Image generation via OpenRouter's chat/completions with
  // modalities: ["image","text"].
  image_gen: "google/gemini-3.1-flash-image-preview",
} as const;

export type ModelKey = keyof typeof MODELS;

// ─── Curated chat-model list ────────────────────────────────────────
//
// What the model picker shows. GET /api/models intersects this list with
// OpenRouter's live catalog to flag availability. `context` is the
// advertised context window in tokens; `pricingHint` is display-only
// (cost math lives in cost.ts).

export interface ChatModelInfo {
  id: string;
  label: string;
  provider: string;
  context: number;
  supportsVision: boolean;
  supportsTools: boolean;
  pricingHint: string;
}

export const CHAT_MODELS: ChatModelInfo[] = [
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "Anthropic",
    context: 1_000_000,
    supportsVision: true,
    supportsTools: true,
    pricingHint: "$2 in / $10 out per 1M tokens",
  },
  {
    id: "anthropic/claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "Anthropic",
    context: 200_000,
    supportsVision: true,
    supportsTools: true,
    pricingHint: "$0.80 in / $4 out per 1M tokens",
  },
  {
    id: "openai/gpt-5",
    label: "GPT-5",
    provider: "OpenAI",
    context: 400_000,
    supportsVision: true,
    supportsTools: true,
    pricingHint: "$1.25 in / $10 out per 1M tokens",
  },
  {
    id: "openai/gpt-4o-mini",
    label: "GPT-4o mini",
    provider: "OpenAI",
    context: 128_000,
    supportsVision: true,
    supportsTools: true,
    pricingHint: "$0.15 in / $0.60 out per 1M tokens",
  },
  {
    id: "google/gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "Google",
    context: 1_048_576,
    supportsVision: true,
    supportsTools: true,
    pricingHint: "$1.25 in / $10 out per 1M tokens",
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "Google",
    context: 1_048_576,
    supportsVision: true,
    supportsTools: true,
    pricingHint: "$0.30 in / $2.50 out per 1M tokens",
  },
  {
    id: "deepseek/deepseek-r1",
    label: "DeepSeek R1",
    provider: "DeepSeek",
    context: 163_840,
    supportsVision: false,
    supportsTools: false,
    pricingHint: "$0.55 in / $2.19 out per 1M tokens",
  },
  {
    id: "meta-llama/llama-4-maverick",
    label: "Llama 4 Maverick",
    provider: "Meta",
    context: 1_048_576,
    supportsVision: true,
    supportsTools: true,
    pricingHint: "$0.18 in / $0.60 out per 1M tokens",
  },
];
