// Shared text-embedding helper + cosine similarity.
//
// One embedding call, routed through OpenRouter (OPENROUTER_API_KEY)
// using whatever model MODELS.embedding points at —
// openai/text-embedding-3-small (1536-dim) by default, matching the
// vec_hub_memory index size. OpenRouter exposes the same /embeddings
// shape OpenAI uses. Returns null on ANY failure (no key, API down,
// unexpected shape) so callers fall back to a non-embedding path
// rather than throwing.

import { env } from "@omni/env-config";
import { traceable } from "langsmith/traceable";
import { MODELS } from "./models.js";

const tracingEnabled = env.LANGSMITH_TRACING === "true";

async function embedTextImpl(text: string): Promise<number[] | null> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const input = text.trim();
  if (!input) return null;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODELS.embedding,
        input,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { data?: { embedding: number[] }[] };
    return data.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

// Traced in LangSmith only when tracing is on. processOutputs records
// only the vector count + dims so the trace keeps timing without
// dumping raw embedding vectors.
export const embedText: (text: string) => Promise<number[] | null> =
  tracingEnabled
    ? (traceable(embedTextImpl, {
        name: "embedText",
        run_type: "retriever",
        processOutputs: (o) => {
          const vec = (o as { outputs?: number[] | null }).outputs ?? null;
          return { count: vec ? 1 : 0, dims: vec?.length ?? 0 };
        },
      }) as unknown as typeof embedTextImpl)
    : embedTextImpl;

// Cosine similarity of two equal-length vectors. Returns 0 on any
// degenerate input (mismatched length, zero vector) so it never throws
// inside a similarity sweep.
export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
