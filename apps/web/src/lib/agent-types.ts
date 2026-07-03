// Super Agent (Phase 3) shared types. These mirror, exactly, the two shared
// contracts the engine and this UI agree on:
//   1. the agent SSE event protocol (the `AgentEvent` union below), and
//   2. the agent_runs / agent_steps rows returned by the REST endpoints.
// If the engine returns a different shape, reconcile HERE — every agent
// component imports from this module.

import type { ArtifactSummary } from "@/lib/types";

// ── Run + plan ────────────────────────────────────────────────────────────

export type AgentRunStatus =
  | "queued"
  | "planning"
  | "running"
  | "awaiting_confirmation"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type PlanItemStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";

export interface PlanItem {
  id: string;
  title: string;
  status: PlanItemStatus;
  note?: string;
}

// GET /api/agent/runs (list rows) and the flat part of GET /api/agent/runs/:id.
// `plan` and `pending_confirmation` arrive JSON-parsed. Fields the engine adds
// to the DETAIL payload but omits from LIST rows are optional here so one type
// satisfies both.
export interface AgentRun {
  id: string;
  user_id?: string;
  hub_id: string | null;
  thread_id: string | null;
  title: string | null;
  goal: string;
  status: AgentRunStatus;
  plan: PlanItem[];
  model: string | null;
  iter_count: number;
  max_iterations: number;
  budget_usd: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  final_output: string | null;
  error: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at: string | null;
  // ── detail-only (may be absent on list rows) ──
  pending_confirmation?: ConfirmationCard | null;
  resumable?: number | boolean;
  cancel_requested?: number | boolean;
  pause_requested?: number | boolean;
  last_event_seq?: number;
}

// GET /api/agent/runs/:id — the flat run with its steps attached.
export interface AgentRunDetail extends AgentRun {
  steps: AgentStep[];
}

// ── Steps ─────────────────────────────────────────────────────────────────

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

export type StepStatus = "running" | "ok" | "error" | "skipped";

// A unified timeline record. Rows from the snapshot (GET :id → steps[]) and
// rows synthesised from live SSE events both normalise to this shape and are
// deduped by `seq`. The last few fields carry data that only ever arrives on a
// live event (`artifact`, `full_available`, `label`, `args_preview`); they are
// best-effort reconstructed for snapshot rows.
export interface AgentStep {
  id?: string;
  run_id?: string;
  seq: number;
  iter: number;
  kind: StepKind;
  tool_name: string | null;
  tool_args?: Record<string, unknown> | null;
  status: StepStatus | null;
  content: string | null;
  summary: string | null;
  cost_usd?: number | null;
  duration_ms: number | null;
  created_at?: string;
  full_content_path?: string | null;
  // live-event enrichments
  label?: string;
  args_preview?: string;
  full_available?: boolean;
  artifact?: ArtifactSummary;
  // GET /api/agent/runs/:id attaches the parsed SSE event to each step row so
  // the UI can normalise snapshot rows through the same path as live events.
  event?: AgentEvent;
}

// ── Confirmation card ───────────────────────────────────────────────────────

export interface ConfirmationCard {
  card_id: string;
  tool_name: string;
  description: string;
  args: Record<string, unknown>;
  /** 'write' → an external side-effect awaiting Confirm/Skip;
   *  'question' → ask_user, awaiting a typed answer (or a choice). */
  reason: "write" | "question";
  choices?: string[];
}

export type ConfirmAction = "confirm" | "skip";

// ── SSE event union (THE contract) ──────────────────────────────────────────
// Persisted events carry a `seq` (== the SSE `id:` line); `delta` and `close`
// do not.

export type AgentEvent =
  | {
      type: "run_status";
      status: AgentRunStatus;
      iter: number;
      cost_usd: number;
      budget_usd: number;
    }
  | { type: "plan_updated"; plan: PlanItem[] }
  | { type: "delta"; text: string }
  | { type: "assistant_message"; seq: number; text: string }
  | {
      type: "tool_call";
      seq: number;
      iter: number;
      tool: string;
      label: string;
      args_preview?: string;
    }
  | {
      type: "tool_result";
      seq: number;
      tool: string;
      status: StepStatus;
      preview: string;
      duration_ms: number;
      full_available: boolean;
    }
  | { type: "artifact_created"; seq: number; artifact: ArtifactSummary }
  | { type: "confirmation_required"; seq: number; card: ConfirmationCard }
  | { type: "confirmation_resolved"; seq: number; card_id: string; action: string }
  | { type: "compaction"; seq: number; folded_steps: number }
  | { type: "budget_warning"; seq: number; cost_usd: number; budget_usd: number }
  | {
      type: "run_completed";
      seq: number;
      final_output: string;
      artifacts: ArtifactSummary[];
      cost_usd: number;
      iter_count: number;
    }
  | { type: "error"; seq?: number; message: string }
  | { type: "close" };

export type AgentEventType = AgentEvent["type"];

// Statuses at which the run has stopped for good — the stream client stops
// auto-reconnecting and the header hides in-flight controls.
export const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminalStatus(status: AgentRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// A run is "active" (loop can produce more events without user action) when
// it is neither terminal nor suspended waiting on the user.
export function isActiveStatus(status: AgentRunStatus): boolean {
  return status === "queued" || status === "planning" || status === "running";
}
