// Unified LLM interface — one OpenAI SDK client pointed at OpenRouter.
// Adapted from Flo101's claude.ts: same prompt-caching + provider-pinning
// + JSON-repair machinery, with LangSmith made strictly optional (the
// client and call functions are only wrapped when LANGSMITH_TRACING is
// "true"; otherwise the plain implementations run with zero overhead).

import { env } from "@omni/env-config";
import OpenAI from "openai";
import { wrapOpenAI } from "langsmith/wrappers";
import { traceable, getCurrentRunTree } from "langsmith/traceable";
import { MODELS } from "./models.js";
import { calculateCost, type TokenUsage } from "./cost.js";

const tracingEnabled = env.LANGSMITH_TRACING === "true";

// Accumulator for per-request cost tracking. Callers read this right
// after a callLLM / callLLMJSON call to persist the cost.
let _lastUsage: TokenUsage | null = null;
export function getLastUsage(): TokenUsage | null {
  return _lastUsage;
}

const DEFAULT_MODEL = MODELS.default;

// Current-date block injected into every callLLM system prompt. LLMs
// have no inherent sense of "today" and otherwise treat their training
// cutoff as the present. Server clock is UTC; day-level accuracy is enough.
function currentDateBlock(): string {
  const now = new Date();
  const human = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  const iso = now.toISOString().slice(0, 10);
  return `CURRENT DATE: today is ${human} (${iso}, UTC). This is authoritative - your training data is older, so never infer the current year or month from memory. Judge "today", "current", "latest", and "recent" against THIS date; when freshness matters, trust dated / web-search results over your priors.`;
}

// ─── Client ─────────────────────────────────────────────────────────

const rawClient = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: env.OPENROUTER_API_KEY,
});

// Wrapped for LangSmith tracing ONLY when tracing is on — wrapOpenAI
// otherwise adds a proxy layer (and a hard langsmith dependency at call
// time) for nothing.
export const openai: OpenAI = tracingEnabled ? wrapOpenAI(rawClient) : rawClient;

// Bound every non-streaming call. The OpenAI SDK defaults to a 600s
// per-request timeout with 2 retries — a single stalled OpenRouter
// connection could otherwise hang a request for 10+ minutes. A JSON /
// agent call never legitimately needs more than ~2 min; capping turns a
// hung call into a fast, retryable error. Streaming call sites manage
// their own timeouts and are unaffected.
export const LLM_REQUEST_OPTS: { timeout: number; maxRetries: number } = {
  timeout: 120_000,
  maxRetries: 2,
};

// ─── Types ──────────────────────────────────────────────────────────

export interface LLMRequest {
  system?: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  // Per-request overrides for slow/large calls. The shared LLM_REQUEST_OPTS
  // (120s, 2 retries) is too short for very large single-shot generations
  // (e.g. full-app codegen), which legitimately run several minutes.
  timeout?: number;
  maxRetries?: number;
  // Optional SECOND cached block, placed right after `system` and before
  // the (uncached) date + user prompt. Use for content that's stable
  // across a burst of calls but not across all calls. Must be
  // byte-identical across the calls meant to share the cache.
  cachedContext?: string;
}

// What OpenRouter attaches to responses when usage.include=true. It
// normalises Anthropic's cache counters into OpenAI-style fields:
//   prompt_tokens_details.cached_tokens      -> cache READ
//   prompt_tokens_details.cache_write_tokens -> cache CREATION
interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  } | null;
}

// ─── Anthropic prompt-caching helpers ───────────────────────────────
//
// OpenRouter speaks the OpenAI wire format but forwards the Anthropic
// `cache_control` field through when present on a text content block, so
// stable system prompts get a 90%-off cache read on the 2nd..Nth call
// within the 5-minute TTL. Caching only fires when (1) the model routes
// to Anthropic 1P (see providerRoutingForCache), (2) the cached prefix
// meets Anthropic's minimum cacheable size, and (3) the cached content
// is byte-identical across calls.

// Rough char->token ratio: ~4,000 chars is a safe lower bound for the
// 1,024-token minimum — below that Anthropic silently skips caching.
const MIN_CACHE_CHARS = 4_000;

function isClaudeModel(model: string): boolean {
  return /^anthropic\//i.test(model) || /^claude-/i.test(model);
}

export interface CacheableTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/**
 * Wrap a system-prompt string into an OpenRouter-friendly content array
 * with `cache_control: ephemeral` on the single text block. Returns the
 * raw string for non-Claude models (cache_control would be ignored) or
 * when the prompt is too short to meet Anthropic's minimum-cacheable
 * threshold.
 */
export function wrapSystemForCache(
  system: string,
  model: string,
): string | CacheableTextBlock[] {
  if (!isClaudeModel(model)) return system;
  if (system.length < MIN_CACHE_CHARS) return system;
  return [
    {
      type: "text",
      text: system,
      cache_control: { type: "ephemeral" },
    },
  ];
}

/**
 * OpenRouter-extension fields for Claude models:
 * `provider: { order: ["anthropic"], allow_fallbacks: true }`. Pinning
 * Anthropic 1P keeps cache_control reliable end-to-end; allow_fallbacks
 * stays true so an Anthropic outage routes to Bedrock/Vertex instead of
 * failing (skipping caching for that call — the right trade).
 * Returns {} for non-Claude models.
 */
export function providerRoutingForCache(
  model: string,
): Record<string, unknown> {
  if (!isClaudeModel(model)) return {};
  return {
    provider: {
      order: ["anthropic"],
      allow_fallbacks: true,
    },
  };
}

// ─── Usage capture ──────────────────────────────────────────────────

function recordUsage(
  model: string,
  usage: OpenRouterUsage | null | undefined,
): void {
  if (!usage) return;
  const details = usage.prompt_tokens_details ?? {};
  const cacheRead = details.cached_tokens ?? 0;
  const cacheWrite = details.cache_write_tokens ?? 0;
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const record: TokenUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    cost_usd: calculateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite),
    model,
    ...(cacheRead ? { cache_read_tokens: cacheRead } : {}),
    ...(cacheWrite ? { cache_write_tokens: cacheWrite } : {}),
  };
  _lastUsage = record;
  if (tracingEnabled) {
    try {
      const runTree = getCurrentRunTree();
      Object.assign(runTree.metadata, { ...record, model_used: model });
    } catch {
      // Not inside a traceable() — nothing to enrich.
    }
  }
}

// ─── callLLM ────────────────────────────────────────────────────────

async function callLLMImpl(req: LLMRequest): Promise<string> {
  const {
    system,
    prompt,
    model = DEFAULT_MODEL,
    maxTokens = 4096,
    cachedContext,
    timeout,
    maxRetries,
  } = req;

  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  if (system) {
    // The OpenAI types don't know about the cache_control extension —
    // cast so the content array passes through verbatim to OpenRouter.
    messages.push({
      role: "system",
      content: wrapSystemForCache(system, model) as unknown as string,
    });
  }
  // Second cache breakpoint: stable-per-burst context, placed AFTER the
  // global `system` block (cached prefix = [system][cachedContext]) and
  // BEFORE the daily date + user prompt so neither busts it.
  if (cachedContext) {
    messages.push({
      role: "system",
      content: wrapSystemForCache(cachedContext, model) as unknown as string,
    });
  }
  // Current date as its own short, UNCACHED system block — concatenating
  // it into `system` would bust the byte-identical cache prefix daily.
  messages.push({ role: "system", content: currentDateBlock() });
  messages.push({ role: "user", content: prompt });

  // Body assembled loose, then cast: usage.include opts into OpenRouter's
  // detailed usage payload (cache counters); reasoning.enabled=false
  // hard-disables extended thinking — these are structured-output calls
  // and a reasoning model would burn max_tokens on thinking, truncating
  // the JSON. Both are OpenRouter extensions the OpenAI types don't know.
  const body = {
    model,
    max_tokens: maxTokens,
    messages,
    usage: { include: true },
    reasoning: { enabled: false },
    ...providerRoutingForCache(model),
  } as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming;

  const requestOpts = {
    ...LLM_REQUEST_OPTS,
    ...(timeout !== undefined ? { timeout } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  };
  const res = await openai.chat.completions.create(body, requestOpts);

  recordUsage(model, (res as unknown as { usage?: OpenRouterUsage }).usage);

  const content = res.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim().length > 0) return content;
  // Some models/providers return content as an array of parts —
  // concatenate the text parts rather than throwing.
  if (Array.isArray(content)) {
    const joined = (content as unknown[])
      .map((p) => (typeof p === "string" ? p : ((p as { text?: string })?.text ?? "")))
      .join("")
      .trim();
    if (joined) return joined;
  }
  // Empty/unreadable (e.g. finish_reason 'length' truncation) — a
  // clearer, retryable error than dumping the whole response object.
  const finish = res.choices?.[0]?.finish_reason;
  throw new Error(
    `Empty or unreadable model response (finish_reason=${finish ?? "unknown"})`,
  );
}

/**
 * One-shot prompt -> text. Traced in LangSmith only when
 * LANGSMITH_TRACING === "true"; otherwise the plain implementation runs.
 */
export const callLLM: (req: LLMRequest) => Promise<string> = tracingEnabled
  ? (traceable(callLLMImpl, {
      name: "callLLM",
      run_type: "llm",
      metadata: { ls_provider: "openrouter" },
    }) as unknown as typeof callLLMImpl)
  : callLLMImpl;

// ─── streamLLM ──────────────────────────────────────────────────────

/**
 * Streaming variant of callLLM: yields text deltas as they arrive. Same
 * caching / provider routing / timeout controls as callLLM, but stream:true so
 * the caller can parse output incrementally (e.g. file-by-file codegen) and the
 * connection keeps producing tokens on long generations. Usage is recorded when
 * the stream ends. Not traced through LangSmith (streaming spans add little).
 */
export async function* streamLLM(req: LLMRequest): AsyncGenerator<string, void, unknown> {
  const {
    system,
    prompt,
    model = DEFAULT_MODEL,
    maxTokens = 4096,
    cachedContext,
    timeout,
    maxRetries,
  } = req;

  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  if (system) {
    messages.push({ role: "system", content: wrapSystemForCache(system, model) as unknown as string });
  }
  if (cachedContext) {
    messages.push({ role: "system", content: wrapSystemForCache(cachedContext, model) as unknown as string });
  }
  messages.push({ role: "system", content: currentDateBlock() });
  messages.push({ role: "user", content: prompt });

  const body = {
    model,
    max_tokens: maxTokens,
    messages,
    reasoning: { enabled: false },
    stream: true,
    stream_options: { include_usage: true },
    ...providerRoutingForCache(model),
  } as unknown as OpenAI.ChatCompletionCreateParamsStreaming;

  const requestOpts = {
    ...LLM_REQUEST_OPTS,
    ...(timeout !== undefined ? { timeout } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  };

  const stream = (await openai.chat.completions.create(body, requestOpts)) as unknown as AsyncIterable<{
    choices?: Array<{ delta?: { content?: string | null } }>;
    usage?: OpenRouterUsage;
  }>;
  let usage: OpenRouterUsage | undefined;
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) yield delta;
    if (chunk.usage) usage = chunk.usage;
  }
  if (usage) recordUsage(model, usage);
}

// ─── callLLMJSON ────────────────────────────────────────────────────

/**
 * One-shot prompt -> parsed JSON. Appends strict JSON instructions to the
 * system prompt, then retries ONCE on a malformed/empty response with a
 * DOUBLED token budget — the two residual failure modes on a verbose
 * model are a stochastic bad sample and truncation when the JSON overruns
 * max_tokens. Raising the cap never forces longer output, so short
 * responses cost the same.
 */
export async function callLLMJSON<T>(req: LLMRequest): Promise<T> {
  const systemWithJSON =
    `${req.system || ""}\n\nRespond ONLY with valid JSON. No markdown, no code fences, no comments, no trailing commas. Use straight double quotes (") never smart quotes. Every property name must be in double quotes.`.trim();

  const baseTokens = req.maxTokens ?? 4096;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const maxTokens =
        attempt === 0
          ? Math.max(baseTokens, 2048)
          : Math.max(baseTokens * 2, 4096);
      const text = await callLLM({ ...req, system: systemWithJSON, maxTokens });
      return parseLLMJSON<T>(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ─── JSON repair ────────────────────────────────────────────────────

// Escape raw control characters (newlines, tabs, etc.) that appear INSIDE
// string literals. Models writing long prose values sometimes emit real
// paragraph breaks as literal newlines inside a JSON string instead of
// "\n" — which JSON.parse rejects. Structural whitespace BETWEEN tokens
// is left untouched; only chars inside an open string are escaped.
function escapeControlCharsInStrings(s: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        out += ch;
        escape = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escape = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      const code = s.charCodeAt(i);
      if (code < 0x20) {
        if (ch === "\n") out += "\\n";
        else if (ch === "\t") out += "\\t";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\b") out += "\\b";
        else if (ch === "\f") out += "\\f";
        else out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += ch;
      continue;
    }
    out += ch;
    if (ch === '"') inString = true;
  }
  return out;
}

// Lenient LLM-JSON parser. Handles the output quirks that recur in prod:
//   1) markdown ```json fences around an otherwise-valid body
//   2) smart quotes instead of straight ASCII quotes
//   3) trailing commas before } / ]
//   4) raw control chars (literal newlines/tabs) inside string values
// Plus brace-aware extraction of the outermost { ... } so any prose the
// model tacks on before/after the JSON object is discarded. Strict parse
// is tried first; repairs only run on failure.
export function parseLLMJSON<T>(raw: string): T {
  const stripped = raw
    .replace(/^```json?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const start = stripped.indexOf("{");
  if (start < 0) {
    throw new Error("Model returned no JSON object.");
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
    } else {
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
  }
  const candidate =
    end > 0 ? stripped.slice(start, end + 1) : stripped.slice(start);

  try {
    return JSON.parse(candidate) as T;
  } catch {
    const repaired = escapeControlCharsInStrings(
      candidate.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"),
    ).replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(repaired) as T;
    } catch (err) {
      throw new Error(
        `Model returned malformed JSON: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }
}
