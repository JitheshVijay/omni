// Per-model cost lookup (USD per million tokens). Source: OpenRouter
// pricing pages — what we actually pay after OpenRouter's margin.
// Covers the curated CHAT_MODELS list plus the embedding + image slots.

const COST_PER_M_TOKENS: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-5": { input: 2, output: 10 },
  "anthropic/claude-haiku-4-5": { input: 0.8, output: 4 },
  "openai/gpt-5": { input: 1.25, output: 10 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "google/gemini-2.5-pro": { input: 1.25, output: 10 },
  "google/gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "deepseek/deepseek-r1": { input: 0.55, output: 2.19 },
  "meta-llama/llama-4-maverick": { input: 0.18, output: 0.6 },
  "openai/text-embedding-3-small": { input: 0.02, output: 0 },
  "google/gemini-3.1-flash-image-preview": { input: 0.15, output: 0.6 },
  "google/gemini-2.5-flash-image": { input: 0.15, output: 0.6 },
};

// Fallback for unknown models — priced at the default (Sonnet 5) tier so
// unknown-model costs err high rather than low.
const DEFAULT_COST = { input: 2, output: 10 };

// Resolve pricing, stripping OpenRouter variant suffixes (:online,
// :nitro, :free…) so "anthropic/claude-haiku-4-5:online" bills at the
// base model's rate. (The web-search plugin surcharge is not modelled.)
function pricingFor(model: string): { input: number; output: number } {
  return (
    COST_PER_M_TOKENS[model] ??
    COST_PER_M_TOKENS[model.replace(/:[a-z0-9_-]+$/i, "")] ??
    DEFAULT_COST
  );
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  model: string;
  // Anthropic prompt-caching breakdown. Cache reads cost 0.1x the base
  // input rate, writes cost 1.25x (5m TTL). Populated when OpenRouter
  // surfaces these counters on prompt_tokens_details; absent when the
  // call didn't use a Claude model or didn't carry cache_control.
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/**
 * Cost in USD for one call. `inputTokens` includes any cached tokens per
 * OpenRouter's accounting — cache reads/writes are subtracted out and
 * re-added at their discounted (0.1x) / premium (1.25x) rates.
 * Rounded to 6 decimal places.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead = 0,
  cacheWrite = 0,
): number {
  const pricing = pricingFor(model);
  const uncachedInput = Math.max(0, inputTokens - cacheRead - cacheWrite);
  const cost =
    (uncachedInput / 1_000_000) * pricing.input +
    (cacheRead / 1_000_000) * pricing.input * 0.1 +
    (cacheWrite / 1_000_000) * pricing.input * 1.25 +
    (outputTokens / 1_000_000) * pricing.output;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
