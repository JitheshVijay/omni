// The Super Agent run loop.
//
//   startRun(runId)   — fresh run: seed system+goal, plan → act → observe.
//   resumeRun(runId)  — re-enter from a checkpoint: after a confirmation
//                       (drain the queued calls), a pause, or crash recovery.
//
// One suspension mechanism serves confirmation / ask_user / pause / crash:
// checkpoint the exact message array to context_snapshot and RETURN from the
// loop function (no held promises). The route's confirm/resume handlers call
// resumeRun to continue. Persist-before-emit throughout: every agent_steps
// row is written before its SSE event is published (persistence.persistStep).
import {
  MODELS,
  all,
  calculateCost,
  logger,
  nowISO,
  one,
  openai,
  providerRoutingForCache,
  run as dbRun,
  wrapSystemForCache,
} from "@omni/sdk";
import {
  toArtifactSummary,
  type ArtifactRow,
  type ArtifactSummary,
} from "../generators/types.js";
import {
  loadRun,
  nextSeq,
  persistStep,
  updateRun,
  type RunRow,
  type StepKind,
} from "./persistence.js";
import { publish, type AgentEvent } from "./run-bus.js";
import {
  elideOldToolMessages,
  shouldCompact,
  toWireMessages,
  type ConvMsg,
  type OaiToolCall,
} from "./compaction.js";
import {
  ensureWorkspaceDir,
  maybeSpill,
  startWorkspaceSweep,
  SPILL_THRESHOLD_BYTES,
} from "./workspace.js";
import { getToolMapForUser, getToolSpecsForUser } from "./tools/registry.js";
import { normalizePlan } from "./tools/builtin.js";
import {
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_TOOL_TIMEOUT_MS,
  DESTRUCTIVE_LABEL,
  effectiveKind,
  type AgentTool,
  type AgentToolCtx,
  type ToolResult,
} from "./tools/types.js";

const MAX_TOOLS_PER_ITER = 8;
const STUCK_NUDGE_AT = 3;
const STUCK_SYNTH_AT = 5;

export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// ─── live AbortController registry ──────────────────────────────────

const controllers = new Map<string, AbortController>();

export function isRunning(runId: string): boolean {
  return controllers.has(runId);
}

/** Abort the live loop for a run (cancel). Returns whether one was aborted. */
export function abortRun(runId: string): boolean {
  const ac = controllers.get(runId);
  if (!ac) return false;
  ac.abort();
  return true;
}

// ─── streaming completion ───────────────────────────────────────────

interface StreamCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: StreamUsage | null;
}

// The OpenAI SDK create() overloads fight structural message arrays; bind a
// loosely-typed alias (same trick as the doc generator).
const createChatStream = openai.chat.completions.create.bind(openai.chat.completions) as unknown as (
  body: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<AsyncIterable<StreamChunk>>;

interface CompletionOut {
  text: string;
  calls: StreamCall[];
  usage: StreamUsage | null;
}

async function streamCompletion(
  runId: string,
  messages: ConvMsg[],
  model: string,
  signal: AbortSignal,
  withTools: boolean,
  toolSpecs?: Array<Record<string, unknown>>,
): Promise<CompletionOut> {
  const wire = toWireMessages(messages);
  // Cache the (stable) system prompt on Claude models.
  if (wire[0]?.role === "system" && typeof wire[0].content === "string") {
    wire[0] = { ...wire[0], content: wrapSystemForCache(wire[0].content as string, model) };
  }
  const body: Record<string, unknown> = {
    model,
    messages: wire,
    stream: true,
    stream_options: { include_usage: true },
    ...providerRoutingForCache(model),
  };
  if (withTools) {
    body.tools = toolSpecs ?? [];
    body.tool_choice = "auto";
  }

  const stream = await createChatStream(body, { timeout: 120_000, maxRetries: 2, signal });

  let text = "";
  const acc: Array<{ id?: string; name?: string; args: string }> = [];
  let usage: StreamUsage | null = null;
  for await (const chunk of stream) {
    if (signal.aborted) throw new Error("aborted");
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    if (typeof delta.content === "string" && delta.content.length > 0) {
      text += delta.content;
      publish(runId, { type: "delta", text: delta.content });
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = typeof tc.index === "number" ? tc.index : 0;
      if (!acc[idx]) acc[idx] = { args: "" };
      if (tc.id) acc[idx].id = tc.id;
      if (tc.function?.name) acc[idx].name = tc.function.name;
      if (tc.function?.arguments) acc[idx].args += tc.function.arguments;
    }
  }

  const calls: StreamCall[] = acc
    .filter((c) => c.id && c.name)
    .map((c) => ({ id: c.id as string, name: c.name as string, args: safeParseArgs(c.args) }));
  return { text, calls, usage };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  const s = (raw || "{}").trim();
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function accumulateUsage(runId: string, model: string, usage: StreamUsage | null): void {
  if (!usage) return;
  const details = usage.prompt_tokens_details ?? {};
  const inTok = usage.prompt_tokens ?? 0;
  const outTok = usage.completion_tokens ?? 0;
  const cacheRead = details.cached_tokens ?? 0;
  const cacheWrite = details.cache_write_tokens ?? 0;
  const cost = calculateCost(model, inTok, outTok, cacheRead, cacheWrite);
  dbRun(
    "UPDATE agent_runs SET cost_usd = cost_usd + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?",
    cost,
    inTok,
    outTok,
    runId,
  );
}

// ─── persisted-step helper (persist-before-emit) ────────────────────

interface StepExtra {
  toolName?: string | null;
  status?: "running" | "ok" | "error" | "skipped" | null;
  summary?: string | null;
  fullContentPath?: string | null;
  costUsd?: number | null;
  durationMs?: number | null;
  toolArgs?: unknown;
}

/** Allocate a seq, stamp it on the event, persist the row + publish. */
function step(
  runId: string,
  userId: string,
  iter: number,
  kind: StepKind,
  event: Record<string, unknown> & { type: string },
  extra: StepExtra = {},
): number {
  const seq = nextSeq(runId);
  const evt: AgentEvent = { ...event, seq };
  persistStep({
    runId,
    userId,
    seq,
    iter,
    kind,
    content: JSON.stringify(evt),
    event: evt,
    toolName: extra.toolName ?? null,
    status: extra.status ?? null,
    summary: extra.summary ?? null,
    fullContentPath: extra.fullContentPath ?? null,
    costUsd: extra.costUsd ?? null,
    durationMs: extra.durationMs ?? null,
    toolArgs: extra.toolArgs,
  });
  return seq;
}

function emitStatus(runId: string): void {
  const r = loadRun(runId);
  if (!r) return;
  publish(runId, {
    type: "run_status",
    status: r.status,
    iter: r.iter_count,
    cost_usd: r.cost_usd,
    budget_usd: r.budget_usd,
  });
}

function loadArtifacts(runId: string): ArtifactSummary[] {
  const rows = all<ArtifactRow>(
    "SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC",
    runId,
  );
  return rows.map(toArtifactSummary);
}

// ─── system prompt ──────────────────────────────────────────────────

const AGENT_PERSONA = `You are Omni's autonomous Super Agent. You accomplish a user's goal end-to-end by planning, using tools, observing results, and adapting — then delivering a clear final answer.

OPERATING RULES
1. PLAN FIRST. Your very first action MUST be a call to update_plan with a short ordered checklist (3-8 concrete steps). Keep the plan current: before starting a step call update_plan marking it in_progress; after finishing mark it done. If a step fails or becomes irrelevant, mark it failed or skipped and add/revise steps as needed. Always send the COMPLETE plan — it is a full replacement, never a diff.
2. USE TOOLS DELIBERATELY. Prefer web_search + fetch_url for external facts; drive_list/drive_read and hub_memory_search for the user's own material; the create_* generator tools to produce artifacts (documents, images, slides, audio). One tool call should have a clear purpose tied to a plan step.
3. GROUND AND CITE. When you state external facts, base them on tool results and reference your sources in the final answer. Never fabricate URLs, quotes, or data.
4. HANDLE FAILURE. Tool errors come back as tool results. If a tool fails, try an alternative or adjust the plan; do not repeat the same failing call more than twice. If you are truly blocked on missing information only the user can provide, call ask_user.
5. RESPECT CONFIRMATIONS. Some actions require the user to confirm before they run; make the intent of such a call obvious.
6. FINISH CLEANLY. When the goal is met, respond with a final prose answer and NO tool calls. Summarize what you did, reference any artifacts you created (by title), and cite sources. That prose reply ends the run.

Be efficient: don't over-search, don't pad. Aim for the shortest sound path to a correct, well-supported result.`;

function buildSystemPrompt(run: RunRow): string {
  const parts = [AGENT_PERSONA];
  const now = new Date();
  parts.push(
    `CURRENT DATE: ${now.toISOString().slice(0, 10)} (UTC). Treat this as authoritative for "today"/"latest"/"recent".`,
  );
  if (run.hub_id) {
    const hub = one<{ name: string; description: string | null; instructions: string | null }>(
      "SELECT name, description, instructions FROM hubs WHERE id = ?",
      run.hub_id,
    );
    if (hub) {
      const hubParts = [`This run is attached to the hub "${hub.name}".`];
      if (hub.description) hubParts.push(`Hub description: ${hub.description}`);
      if (hub.instructions) hubParts.push(`Hub instructions: ${hub.instructions}`);
      hubParts.push(
        "Use hub_memory_search / drive_read to draw on the hub's files where relevant.",
      );
      parts.push(hubParts.join("\n"));
    }
  }
  if (run.interactive === 0) {
    parts.push(
      "UNATTENDED MODE: You are running as an automated workflow step. There is no user available to answer questions, and the ask_user tool is unavailable. If the goal is ambiguous or details are missing, state the single most reasonable assumption in one line and proceed. Never stop to ask; always produce a best-effort final result from what you can gather.",
    );
  }
  return parts.join("\n\n");
}

function buildInitialMessages(run: RunRow): ConvMsg[] {
  return [
    { role: "system", content: buildSystemPrompt(run), iter: 0, pinned: true },
    { role: "user", content: run.goal, iter: 0, pinned: true },
  ];
}

// ─── message helpers ────────────────────────────────────────────────

function assistantToolCallMsg(text: string, calls: StreamCall[], iter: number): ConvMsg {
  const tool_calls: OaiToolCall[] = calls.map((c) => ({
    id: c.id,
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.args) },
  }));
  return { role: "assistant", content: text.trim() ? text : null, tool_calls, iter };
}

function toolResultMsg(call: StreamCall, content: string, iter: number, summary: string): ConvMsg {
  return {
    role: "tool",
    tool_call_id: call.id,
    name: call.name,
    content,
    iter,
    elidable: true,
    summary,
  };
}

// ─── loop context ───────────────────────────────────────────────────

interface LoopState {
  runId: string;
  userId: string;
  model: string;
  maxIter: number;
  budget: number;
  signal: AbortSignal;
  baseCtx: AgentToolCtx;
  toolMap: Map<string, AgentTool>;
  toolSpecs: Array<Record<string, unknown>>;
  messages: ConvMsg[];
  iter: number;
  budgetWarned: boolean;
  stuckNudged: boolean;
  errorStreak: number;
}

interface Resolution {
  action: "confirm" | "skip";
  answer?: string;
}

// ─── entrypoints ────────────────────────────────────────────────────

export async function startRun(runId: string): Promise<void> {
  startWorkspaceSweep();
  const run = loadRun(runId);
  if (!run) return;
  if (controllers.has(runId)) return; // already live
  updateRun(runId, {
    status: "planning",
    started_at: run.started_at ?? nowISO(),
    resumable: 0,
    error: null,
  });
  step(runId, run.user_id, 0, "run_started", { type: "run_status", status: "planning" });
  emitStatus(runId);
  await drive(runId, buildInitialMessages(loadRun(runId)!), 0, undefined);
}

export async function resumeRun(runId: string, resolution?: Resolution): Promise<void> {
  startWorkspaceSweep();
  const run = loadRun(runId);
  if (!run) return;
  if (controllers.has(runId)) return;
  let messages: ConvMsg[];
  try {
    messages = run.context_snapshot ? (JSON.parse(run.context_snapshot) as ConvMsg[]) : [];
  } catch {
    messages = [];
  }
  if (messages.length === 0) messages = buildInitialMessages(run);

  if (resolution && run.pending_confirmation) {
    let pc: PendingConfirmation | null;
    try {
      pc = JSON.parse(run.pending_confirmation) as PendingConfirmation;
    } catch {
      pc = null;
    }
    step(runId, run.user_id, pc?.iter ?? run.iter_count, "confirmation_resolved", {
      type: "confirmation_resolved",
      card_id: pc?.card_id ?? "",
      action: resolution.action,
    });
    updateRun(runId, { status: "running", pending_confirmation: null, resumable: 0, error: null });
    emitStatus(runId);
    await drive(runId, messages, pc?.iter ?? run.iter_count, { pc, resolution });
    return;
  }

  // Pause / crash-recovery resume: re-enter at the last completed boundary.
  updateRun(runId, { status: "running", pause_requested: 0, resumable: 0, error: null });
  step(runId, run.user_id, run.iter_count, "run_resumed", { type: "run_status", status: "running" });
  emitStatus(runId);
  await drive(runId, messages, run.iter_count, undefined);
}

interface PendingConfirmation {
  card_id: string;
  tool_call_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  description: string;
  reason: "write" | "question";
  remaining_calls: StreamCall[];
  iter: number;
}

// ─── the driver ─────────────────────────────────────────────────────

async function drive(
  runId: string,
  messages: ConvMsg[],
  startIter: number,
  pending: { pc: PendingConfirmation | null; resolution: Resolution } | undefined,
): Promise<void> {
  const run = loadRun(runId);
  if (!run) return;
  const controller = new AbortController();
  controllers.set(runId, controller);
  const workspaceDir = await ensureWorkspaceDir(runId);

  const baseCtx: AgentToolCtx = {
    runId,
    userId: run.user_id,
    signal: controller.signal,
    workspaceDir,
    hubId: run.hub_id,
    emit: (evt) => publish(runId, evt as AgentEvent),
  };

  // Unattended (workflow) runs have no user to answer, so drop ask_user; the
  // system prompt tells the model to assume-and-proceed instead of suspending.
  const toolMap = await getToolMapForUser(run.user_id);
  let toolSpecs = await getToolSpecsForUser(run.user_id);
  if (run.interactive === 0) {
    toolMap.delete("ask_user");
    toolSpecs = toolSpecs.filter(
      (s) => (s as { function?: { name?: string } }).function?.name !== "ask_user",
    );
  }

  const state: LoopState = {
    runId,
    userId: run.user_id,
    model: run.model || MODELS.agent,
    maxIter: run.max_iterations,
    budget: run.budget_usd,
    signal: controller.signal,
    baseCtx,
    toolMap,
    toolSpecs,
    messages,
    iter: startIter,
    budgetWarned: false,
    stuckNudged: false,
    errorStreak: 0,
  };

  try {
    // Drain a pending confirmation first (finish the interrupted iteration).
    if (pending?.pc) {
      const res = await executeTools(state, pending.pc.remaining_calls, pending.pc.iter, {
        resolution: pending.resolution,
      });
      if (res === "suspended") return;
      state.messages = await boundary(state, pending.pc.iter);
      state.iter = pending.pc.iter + 1;
    }

    for (; state.iter < state.maxIter; state.iter++) {
      const fresh = loadRun(runId);
      if (!fresh) return;
      if (fresh.cancel_requested) return finishCancelled(state);
      if (fresh.pause_requested) return finishPaused(state);
      if (fresh.cost_usd >= state.budget) {
        await forcedSynthesis(state, "budget_exhausted");
        return;
      }
      maybeBudgetWarn(state, fresh);

      // One completion.
      const { text, calls, usage } = await streamCompletion(
        runId,
        state.messages,
        state.model,
        state.signal,
        true,
        state.toolSpecs,
      );
      accumulateUsage(runId, state.model, usage);

      if (text.trim()) {
        step(runId, state.userId, state.iter, "assistant_message", {
          type: "assistant_message",
          text,
        });
      }

      if (calls.length === 0) {
        await complete(state, text, undefined);
        return;
      }

      const sliced = calls.slice(0, MAX_TOOLS_PER_ITER);
      state.messages.push(assistantToolCallMsg(text, sliced, state.iter));

      const res = await executeTools(state, sliced, state.iter, undefined);
      if (res === "suspended") return;
      updateErrorStreak(state, res);

      state.messages = await boundary(state, state.iter);

      if (state.errorStreak >= STUCK_SYNTH_AT) {
        await forcedSynthesis(state, "stuck");
        return;
      }
      if (state.errorStreak >= STUCK_NUDGE_AT && !state.stuckNudged) {
        state.stuckNudged = true;
        state.messages.push({
          role: "user",
          content:
            "Several recent tool calls failed. Step back: reconsider your approach, try a different tool or query, or if you have enough to answer, write the final response now.",
          iter: state.iter,
        });
      }
    }

    // Iteration budget exhausted.
    await forcedSynthesis(state, "max_iterations");
  } catch (err) {
    const fresh = loadRun(runId);
    if (fresh?.cancel_requested || (state.signal.aborted && fresh?.status === "cancelled")) {
      finishCancelled(state);
    } else {
      finishFailed(state, err);
    }
  } finally {
    controllers.delete(runId);
  }
}

// ─── tool execution for one iteration ───────────────────────────────

interface ExecOutcome {
  ran: number;
  errored: number;
}

type ExecResult = "done" | "suspended";

async function executeTools(
  state: LoopState,
  calls: StreamCall[],
  iter: number,
  head: { resolution: Resolution } | undefined,
): Promise<ExecResult> {
  const outcome: ExecOutcome = { ran: 0, errored: 0 };
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const headRes = i === 0 && head ? head.resolution : undefined;

    // update_plan — intercepted, produces plan_updated (no tool chip).
    if (call.name === "update_plan") {
      applyUpdatePlan(state, call, iter);
      continue;
    }

    const tool = state.toolMap.get(call.name);

    // ask_user — suspends for a question card, or resumes with the answer.
    if (call.name === "ask_user") {
      if (headRes) {
        const answer =
          headRes.action === "skip" ? "The user declined to answer." : headRes.answer?.trim() || "(no answer provided)";
        state.messages.push(toolResultMsg(call, answer, iter, "user answer"));
        continue;
      }
      suspendForConfirmation(state, call, calls.slice(i), iter, "question");
      return "suspended";
    }

    if (!tool || !tool.execute) {
      state.messages.push(
        toolResultMsg(call, `Unknown tool "${call.name}".`, iter, "unknown tool"),
      );
      recordToolPair(state, call, iter, "error", `Unknown tool "${call.name}".`, 0, null);
      outcome.ran++;
      outcome.errored++;
      continue;
    }

    // Confirmation gate (unless we're resuming this very call).
    if (!headRes) {
      const kind = effectiveKind(tool, call.args);
      const destructive = DESTRUCTIVE_LABEL.test(tool.label(call.args));
      if (kind === "write_external" || destructive) {
        suspendForConfirmation(state, call, calls.slice(i), iter, "write", tool);
        return "suspended";
      }
    }

    // Resuming with a skip: synthesize a skipped result.
    if (headRes && headRes.action === "skip") {
      const msg = "The user skipped this action.";
      state.messages.push(toolResultMsg(call, msg, iter, "skipped by user"));
      recordToolPair(state, call, iter, "skipped", msg, 0, null);
      outcome.ran++;
      continue;
    }

    // Execute.
    const label = safeLabel(tool, call.args);
    step(state.runId, state.userId, iter, "tool_call", {
      type: "tool_call",
      iter,
      tool: call.name,
      label,
      args_preview: JSON.stringify(call.args).slice(0, 200),
    }, { toolName: call.name, status: "running", summary: label, toolArgs: call.args });

    const started = Date.now();
    let result: ToolResult | null = null;
    let errMsg: string | null = null;
    const { signal, cancel } = timeoutSignal(state.signal, tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
    try {
      result = await tool.execute(call.args, { ...state.baseCtx, signal });
    } catch (e) {
      errMsg =
        signal.aborted && !state.signal.aborted
          ? `Tool "${call.name}" timed out.`
          : `Tool "${call.name}" failed: ${(e as Error).message?.slice(0, 300) ?? "error"}`;
    } finally {
      cancel();
    }
    if (state.signal.aborted) throw new Error("aborted");
    const durationMs = Date.now() - started;
    outcome.ran++;

    if (errMsg || !result) {
      outcome.errored++;
      const content = errMsg ?? "Tool returned no result.";
      state.messages.push(toolResultMsg(call, content, iter, `${call.name} error`));
      recordToolResult(state, call, iter, "error", content, durationMs, null);
      continue;
    }

    // Cap for the model; spill the full payload when large.
    const max = tool.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
    const fullContent = result.content ?? "";
    let fullPath: string | null = null;
    if (Buffer.byteLength(fullContent, "utf8") > SPILL_THRESHOLD_BYTES) {
      const seqForSpill = nextSeq(state.runId); // reserve a stable filename seq
      fullPath = await maybeSpill(state.runId, seqForSpill, fullContent);
    }
    const capped =
      fullContent.length > max
        ? `${fullContent.slice(0, max)}\n[...truncated ${fullContent.length - max} chars]`
        : fullContent;
    state.messages.push(toolResultMsg(call, capped, iter, summarize(call.name, capped)));
    recordToolResult(state, call, iter, "ok", capped, durationMs, fullPath);

    // Emit any artifacts produced.
    for (const a of result.artifacts ?? []) {
      linkAndEmitArtifact(state, iter, a.artifactId);
    }
  }
  void outcome;
  return "done";
}

function updateErrorStreak(state: LoopState, _res: ExecResult): void {
  // Recompute from the just-finished iteration's tool results.
  const iterResults = state.messages.filter(
    (m) => m.role === "tool" && m.iter === state.iter,
  );
  if (iterResults.length === 0) return;
  const allErr = iterResults.every((m) => (m.summary ?? "").includes("error"));
  state.errorStreak = allErr ? state.errorStreak + 1 : 0;
}

function safeLabel(tool: AgentTool, args: Record<string, unknown>): string {
  try {
    return tool.label(args);
  } catch {
    return tool.name;
  }
}

function summarize(toolName: string, content: string): string {
  const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
  return `${toolName}: ${firstLine.slice(0, 80)}`;
}

// tool_call already recorded before execute; this records the paired result.
function recordToolResult(
  state: LoopState,
  call: StreamCall,
  iter: number,
  status: "ok" | "error" | "skipped",
  content: string,
  durationMs: number,
  fullPath: string | null,
): void {
  step(state.runId, state.userId, iter, "tool_result", {
    type: "tool_result",
    tool: call.name,
    status,
    preview: content.slice(0, 300),
    duration_ms: durationMs,
    full_available: fullPath != null,
  }, { toolName: call.name, status, durationMs, fullContentPath: fullPath });
}

// For paths that skip the pre-execute tool_call step (unknown tool / skip),
// emit both the call and result so the UI still renders a resolved row.
function recordToolPair(
  state: LoopState,
  call: StreamCall,
  iter: number,
  status: "error" | "skipped",
  content: string,
  durationMs: number,
  fullPath: string | null,
): void {
  step(state.runId, state.userId, iter, "tool_call", {
    type: "tool_call",
    iter,
    tool: call.name,
    label: call.name,
    args_preview: JSON.stringify(call.args).slice(0, 200),
  }, { toolName: call.name, status: "skipped", toolArgs: call.args });
  recordToolResult(state, call, iter, status, content, durationMs, fullPath);
}

function linkAndEmitArtifact(state: LoopState, iter: number, artifactId: string): void {
  dbRun(
    "UPDATE artifacts SET run_id = ? WHERE id = ? AND run_id IS NULL",
    state.runId,
    artifactId,
  );
  const row = one<ArtifactRow>("SELECT * FROM artifacts WHERE id = ?", artifactId);
  if (!row) return;
  const artifact = toArtifactSummary(row);
  step(state.runId, state.userId, iter, "artifact_created", { type: "artifact_created", artifact });
}

function applyUpdatePlan(state: LoopState, call: StreamCall, iter: number): void {
  try {
    const plan = normalizePlan(call.args);
    const patch: Record<string, unknown> = { plan };
    const fresh = loadRun(state.runId);
    if (fresh?.status === "planning") patch.status = "running";
    updateRun(state.runId, patch);
    step(state.runId, state.userId, iter, "plan_updated", { type: "plan_updated", plan });
    if (patch.status === "running") emitStatus(state.runId);
    state.messages.push(
      toolResultMsg(call, `Plan updated (${plan.length} steps).`, iter, "plan updated"),
    );
  } catch (e) {
    state.messages.push(
      toolResultMsg(call, `Invalid plan: ${(e as Error).message}`, iter, "plan error"),
    );
  }
}

// ─── suspension ─────────────────────────────────────────────────────

function suspendForConfirmation(
  state: LoopState,
  call: StreamCall,
  remaining: StreamCall[],
  iter: number,
  reason: "write" | "question",
  tool?: AgentTool,
): void {
  const cardId = cryptoId();
  const description =
    reason === "question"
      ? String(call.args.question ?? "The agent has a question.")
      : `The agent wants to run ${call.name}. ${tool ? tool.label(call.args) : ""}`.trim();
  const choices =
    reason === "question" && Array.isArray(call.args.choices)
      ? (call.args.choices as unknown[]).map(String)
      : undefined;

  const card: Record<string, unknown> = {
    card_id: cardId,
    tool_name: call.name,
    description,
    args: call.args,
    reason,
  };
  if (choices) card.choices = choices;

  step(state.runId, state.userId, iter, "confirmation_required", {
    type: "confirmation_required",
    card,
  });

  const pc: PendingConfirmation = {
    card_id: cardId,
    tool_call_id: call.id,
    tool_name: call.name,
    args: call.args,
    description,
    reason,
    remaining_calls: remaining,
    iter,
  };
  updateRun(state.runId, {
    status: "awaiting_confirmation",
    pending_confirmation: pc,
    context_snapshot: state.messages,
  });
  emitStatus(state.runId);
}

// ─── iteration boundary + compaction ────────────────────────────────

async function boundary(state: LoopState, iter: number): Promise<ConvMsg[]> {
  updateRun(state.runId, { iter_count: iter + 1, context_snapshot: state.messages });
  let messages = state.messages;
  if (shouldCompact(messages)) {
    const { messages: elided, folded } = elideOldToolMessages(messages, iter + 1);
    if (folded > 0) {
      messages = elided;
      step(state.runId, state.userId, iter, "compaction", { type: "compaction", folded_steps: folded });
    }
    if (shouldCompact(messages)) {
      messages = await narrativeFold(state, messages, iter);
    }
    updateRun(state.runId, { context_snapshot: messages });
  }
  return messages;
}

// Tier 3: fold the oldest turns into a single Haiku-written progress log.
async function narrativeFold(state: LoopState, messages: ConvMsg[], iter: number): Promise<ConvMsg[]> {
  // Keep pinned (system+goal) and the last 6 messages; fold the middle.
  const head = messages.filter((m) => m.pinned);
  const tail = messages.slice(-6);
  const middle = messages.filter((m) => !m.pinned && !tail.includes(m));
  if (middle.length < 4) return messages;
  const transcript = middle
    .map((m) => `${m.role}${m.name ? `(${m.name})` : ""}: ${(m.content ?? "").slice(0, 800)}`)
    .join("\n");
  let summaryText: string;
  try {
    const out = await streamCompletion(
      state.runId,
      [
        {
          role: "system",
          content:
            "Compress the following agent transcript into a concise PROGRESS LOG: what was attempted, what was learned, key facts/URLs, and what remains. Bullet points, no fluff.",
        },
        { role: "user", content: transcript },
      ],
      MODELS.cheap,
      state.signal,
      false,
    );
    accumulateUsage(state.runId, MODELS.cheap, out.usage);
    summaryText = out.text.trim();
  } catch (err) {
    logger.warn({ err: (err as Error).message, runId: state.runId }, "[agent] narrative fold failed");
    return messages; // give up on fold; elision already helped
  }
  if (!summaryText) return messages;
  const folded: ConvMsg = {
    role: "user",
    content: `[PROGRESS LOG — earlier steps folded]\n${summaryText}`,
    iter,
  };
  step(state.runId, state.userId, iter, "compaction", { type: "compaction", folded_steps: middle.length });
  return [...head, folded, ...tail];
}

function maybeBudgetWarn(state: LoopState, run: RunRow): void {
  if (state.budgetWarned) return;
  if (run.cost_usd >= 0.8 * state.budget) {
    state.budgetWarned = true;
    step(state.runId, state.userId, state.iter, "budget_warning", {
      type: "budget_warning",
      cost_usd: run.cost_usd,
      budget_usd: state.budget,
    });
    state.messages.push({
      role: "user",
      content: `Note: you have used ${(run.cost_usd / state.budget * 100).toFixed(0)}% of the budget. Wrap up efficiently — prioritize delivering a result over further exploration.`,
      iter: state.iter,
    });
  }
}

// ─── terminal transitions ───────────────────────────────────────────

async function forcedSynthesis(state: LoopState, caveat: string): Promise<void> {
  const note =
    caveat === "budget_exhausted"
      ? "You have reached the cost budget. Do NOT call any more tools. Write the best final answer you can from what you already have, and note any limitations."
      : caveat === "max_iterations"
        ? "You have reached the maximum number of steps. Do NOT call any more tools. Write the best final answer you can now."
        : "You appear to be stuck. Do NOT call any more tools. Write the best final answer you can from what you already have.";
  state.messages.push({ role: "user", content: note, iter: state.iter });
  let text = "";
  try {
    const out = await streamCompletion(state.runId, state.messages, state.model, state.signal, false);
    accumulateUsage(state.runId, state.model, out.usage);
    text = out.text;
    if (text.trim()) {
      step(state.runId, state.userId, state.iter, "assistant_message", {
        type: "assistant_message",
        text,
      });
    }
  } catch (err) {
    if (state.signal.aborted) {
      finishCancelled(state);
      return;
    }
    logger.warn({ err: (err as Error).message, runId: state.runId }, "[agent] forced synthesis failed");
  }
  await complete(state, text || "The run ended before a complete answer could be produced.", caveat);
}

async function complete(state: LoopState, finalText: string, caveat: string | undefined): Promise<void> {
  const artifacts = loadArtifacts(state.runId);
  updateRun(state.runId, {
    status: "completed",
    final_output: finalText,
    finished_at: nowISO(),
    resumable: 0,
    iter_count: state.iter,
  });
  const fresh = loadRun(state.runId);
  step(state.runId, state.userId, state.iter, "run_completed", {
    type: "run_completed",
    final_output: finalText,
    artifacts,
    cost_usd: fresh?.cost_usd ?? 0,
    iter_count: state.iter,
    ...(caveat ? { caveat } : {}),
  });
  emitStatus(state.runId);
  publish(state.runId, { type: "close" });
}

function finishFailed(state: LoopState, err: unknown): void {
  const message = (err as Error)?.message?.slice(0, 500) ?? "Run failed";
  logger.error({ err, runId: state.runId }, "[agent] run failed");
  updateRun(state.runId, {
    status: "failed",
    error: message,
    finished_at: nowISO(),
    resumable: 1,
    context_snapshot: state.messages,
    iter_count: state.iter,
  });
  step(state.runId, state.userId, state.iter, "run_failed", { type: "error", message });
  emitStatus(state.runId);
  publish(state.runId, { type: "close" });
}

function finishCancelled(state: LoopState): void {
  updateRun(state.runId, {
    status: "cancelled",
    finished_at: nowISO(),
    resumable: 0,
    cancel_requested: 0,
    iter_count: state.iter,
  });
  step(state.runId, state.userId, state.iter, "run_cancelled", { type: "run_status", status: "cancelled" });
  emitStatus(state.runId);
  publish(state.runId, { type: "close" });
}

function finishPaused(state: LoopState): void {
  updateRun(state.runId, {
    status: "paused",
    resumable: 1,
    pause_requested: 0,
    context_snapshot: state.messages,
    iter_count: state.iter,
  });
  step(state.runId, state.userId, state.iter, "run_paused", { type: "run_status", status: "paused" });
  emitStatus(state.runId);
}

// ─── small utils ────────────────────────────────────────────────────

function timeoutSignal(parent: AbortSignal, ms: number): { signal: AbortSignal; cancel: () => void } {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (parent.aborted) ac.abort();
  else parent.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(() => ac.abort(), ms);
  t.unref?.();
  return {
    signal: ac.signal,
    cancel: () => {
      clearTimeout(t);
      parent.removeEventListener("abort", onAbort);
    },
  };
}

function cryptoId(): string {
  return (
    Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
  );
}
