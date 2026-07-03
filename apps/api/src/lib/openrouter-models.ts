// OpenRouter model catalog proxy with a 10-minute in-memory cache.
// Fail-soft: returns the last good list (even stale) or [] so the /api/models
// availability flags degrade to "assume available" rather than erroring.
import { env } from "@omni/env-config";
import { logger } from "@omni/sdk";

export interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: Record<string, string>;
  architecture?: Record<string, unknown>;
  [key: string]: unknown;
}

const CACHE_TTL_MS = 10 * 60 * 1000;

let cache: { fetchedAt: number; models: OpenRouterModel[] } | null = null;
let inflight: Promise<OpenRouterModel[]> | null = null;

async function fetchModels(): Promise<OpenRouterModel[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`openrouter /models returned ${res.status}`);
  }
  const data = (await res.json()) as { data?: OpenRouterModel[] };
  return Array.isArray(data.data) ? data.data : [];
}

export async function getOpenRouterModels(): Promise<OpenRouterModel[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }
  if (!inflight) {
    inflight = fetchModels()
      .then((models) => {
        cache = { fetchedAt: Date.now(), models };
        return models;
      })
      .catch((err) => {
        logger.warn(
          { err: (err as Error).message?.slice(0, 200) ?? String(err) },
          "[openrouter-models] fetch failed",
        );
        // Serve the stale list when we have one; [] otherwise.
        return cache?.models ?? [];
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
