// Persist-before-emit: every agent_steps row is written, THEN its SSE
// event is published to the run bus. seq (monotonic per run) doubles as
// the SSE event id used for Last-Event-ID replay. Reconnecting clients
// replay the durable rows and dedupe against the live bus by seq.
import { all, one, run, uuid } from "@omni/sdk";
import { publish, type AgentEvent } from "./run-bus.js";

// ─── seq allocation ─────────────────────────────────────────────────
// last_event_seq lives on the run row; a single UPDATE ... RETURNING is
// atomic under SQLite's write lock, so concurrent allocations can't
// collide (the orchestrator is single-writer per run anyway).
export function nextSeq(runId: string): number {
  const r = one<{ s: number }>(
    "UPDATE agent_runs SET last_event_seq = last_event_seq + 1 WHERE id = ? RETURNING last_event_seq AS s",
    runId,
  );
  if (!r) throw new Error(`nextSeq: run ${runId} not found`);
  return r.s;
}

// ─── step kinds (must match the migration CHECK) ────────────────────
export type StepKind =
  | "run_started"
  | "plan_updated"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "artifact_created"
  | "confirmation_required"
  | "confirmation_resolved"
  | "compaction"
  | "budget_warning"
  | "run_paused"
  | "run_resumed"
  | "run_completed"
  | "run_failed"
  | "run_cancelled";

export interface PersistStepInput {
  runId: string;
  userId: string;
  seq: number;
  iter: number;
  kind: StepKind;
  toolName?: string | null;
  toolArgs?: unknown;
  status?: "running" | "ok" | "error" | "skipped" | null;
  content?: string | null;
  fullContentPath?: string | null;
  summary?: string | null;
  costUsd?: number | null;
  durationMs?: number | null;
  /** The exact SSE payload to publish. Must carry the same seq. */
  event: AgentEvent;
}

/**
 * Insert the step row, then publish its event. The insert is committed
 * before the emit so a client that reconnects an instant later replays
 * the row even if it missed the live frame.
 */
export function persistStep(input: PersistStepInput): void {
  run(
    `INSERT INTO agent_steps
       (id, run_id, user_id, seq, iter, kind, tool_name, tool_args, status,
        content, full_content_path, summary, cost_usd, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uuid(),
    input.runId,
    input.userId,
    input.seq,
    input.iter,
    input.kind,
    input.toolName ?? null,
    input.toolArgs === undefined || input.toolArgs === null
      ? null
      : JSON.stringify(input.toolArgs),
    input.status ?? null,
    input.content ?? null,
    input.fullContentPath ?? null,
    input.summary ?? null,
    input.costUsd ?? null,
    input.durationMs ?? null,
  );
  publish(input.runId, input.event);
}

// ─── run row helpers ────────────────────────────────────────────────

export interface RunRow {
  id: string;
  user_id: string;
  hub_id: string | null;
  thread_id: string | null;
  title: string | null;
  goal: string;
  status: string;
  plan: string;
  context_snapshot: string | null;
  pending_confirmation: string | null;
  model: string | null;
  iter_count: number;
  max_iterations: number;
  /** 0 for unattended workflow-spawned runs (no ask_user, assume-and-proceed). */
  interactive: number;
  budget_usd: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  final_output: string | null;
  error: string | null;
  resumable: number;
  cancel_requested: number;
  pause_requested: number;
  claimed_at: string | null;
  last_event_seq: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const RUN_COLUMNS = new Set([
  "hub_id",
  "thread_id",
  "title",
  "goal",
  "status",
  "plan",
  "context_snapshot",
  "pending_confirmation",
  "model",
  "iter_count",
  "max_iterations",
  "budget_usd",
  "cost_usd",
  "input_tokens",
  "output_tokens",
  "final_output",
  "error",
  "resumable",
  "cancel_requested",
  "pause_requested",
  "claimed_at",
  "started_at",
  "finished_at",
]);

/** Patch a run row. Object/array values are JSON-stringified. */
export function updateRun(runId: string, patch: Record<string, unknown>): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!RUN_COLUMNS.has(key)) continue;
    sets.push(`${key} = ?`);
    params.push(
      value !== null && typeof value === "object" ? JSON.stringify(value) : value,
    );
  }
  if (sets.length === 0) return;
  run(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id = ?`, ...params, runId);
}

export function loadRun(runId: string): RunRow | undefined {
  return one<RunRow>("SELECT * FROM agent_runs WHERE id = ?", runId);
}

// ─── step rows (replay) ─────────────────────────────────────────────

export interface StepRow {
  id: string;
  run_id: string;
  user_id: string;
  seq: number;
  iter: number;
  kind: string;
  tool_name: string | null;
  tool_args: string | null;
  status: string | null;
  content: string | null;
  full_content_path: string | null;
  summary: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: string;
}

/** All steps for a run, in seq order (used by the detail route). */
export function loadSteps(runId: string): StepRow[] {
  return all<StepRow>(
    "SELECT * FROM agent_steps WHERE run_id = ? ORDER BY seq ASC",
    runId,
  );
}

/** Steps with seq strictly greater than `after`, in order (SSE replay). */
export function loadStepsAfter(runId: string, after: number): StepRow[] {
  return all<StepRow>(
    "SELECT * FROM agent_steps WHERE run_id = ? AND seq > ? ORDER BY seq ASC",
    runId,
    after,
  );
}
