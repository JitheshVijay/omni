// 3-tier context management for the agent loop.
//
//   Tier 1 (at insertion, in the orchestrator): tool results are capped to
//           maxResultChars and the full payload spilled to disk >64KB.
//   Tier 2 (here): STRUCTURAL ELISION — tool-result messages older than 3
//           iterations are replaced in place by a mechanical one-liner, so
//           the plan/assistant reasoning stays but stale bulk drops out.
//   Tier 3 (orchestrator, uses MODELS.cheap): NARRATIVE FOLD — when even
//           post-elision context is over the soft cap, the oldest turns are
//           replaced by a single Haiku-written PROGRESS LOG message.
//
// Token estimate: chars / 3.6 (a safe over-estimate for English + JSON, so
// we compact a little early rather than 400 on the model's real limit).
// Everything except the fold is a pure function (unit-tested).

export interface OaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * Conversation message = OpenAI wire fields + orchestrator-only meta
 * (iter/elidable/summary). The meta fields are stripped by toWireMessages
 * before the request is sent; the whole array (with meta) is what gets
 * checkpointed to context_snapshot so resume is exact.
 */
export interface ConvMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
  name?: string;
  // ── meta (never sent to the model) ──
  iter?: number;
  elidable?: boolean;
  elided?: boolean;
  summary?: string;
  pinned?: boolean;
}

export const CHARS_PER_TOKEN = 3.6;
export const SOFT_TOKEN_CAP = 60_000;
export const ELISION_KEEP_ITERS = 3;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Rough serialized length of one message (content + tool-call arguments). */
export function messageChars(m: ConvMsg): number {
  let n = m.content ? m.content.length : 0;
  if (m.tool_calls) {
    for (const tc of m.tool_calls) n += tc.function.name.length + tc.function.arguments.length;
  }
  return n;
}

export function estimateConvTokens(messages: ConvMsg[]): number {
  let chars = 0;
  for (const m of messages) chars += messageChars(m) + 8; // per-message framing
  return estimateTokens(String(chars * CHARS_PER_TOKEN));
}

/** True when the conversation is over the soft input budget. */
export function shouldCompact(messages: ConvMsg[], softCap = SOFT_TOKEN_CAP): boolean {
  let chars = 0;
  for (const m of messages) chars += messageChars(m) + 8;
  return chars / CHARS_PER_TOKEN > softCap;
}

/**
 * Tier 2 — structural elision. Replaces the content of tool-result
 * messages older than `keepIters` iterations with a compact one-liner.
 * Pure: returns a new array and the count of messages folded.
 */
export function elideOldToolMessages(
  messages: ConvMsg[],
  currentIter: number,
  keepIters = ELISION_KEEP_ITERS,
): { messages: ConvMsg[]; folded: number } {
  let folded = 0;
  const out = messages.map((m) => {
    const stale =
      m.role === "tool" &&
      m.elidable === true &&
      m.elided !== true &&
      typeof m.iter === "number" &&
      m.iter < currentIter - keepIters;
    if (!stale) return m;
    folded++;
    const note = m.summary?.trim() || `${m.name ?? "tool"} result`;
    return {
      ...m,
      content: `[earlier ${note} — elided to save context]`,
      elided: true,
    };
  });
  return { messages: out, folded };
}

/** Strip orchestrator-only meta and map to the OpenAI wire shape. */
export function toWireMessages(messages: ConvMsg[]): Record<string, unknown>[] {
  return messages.map((m) => {
    const wire: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_calls) wire.tool_calls = m.tool_calls;
    if (m.tool_call_id) wire.tool_call_id = m.tool_call_id;
    if (m.name) wire.name = m.name;
    return wire;
  });
}
