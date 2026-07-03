// Super Agent — Phase 1 read-only stubs. The schema (agent_runs/agent_steps)
// ships in migration 003; the engine itself lands in Phase 3 (POST run,
// SSE stream with Last-Event-ID replay, confirm/pause/resume/cancel).
import type { FastifyInstance } from "fastify";
import { all, fromJson, one } from "@omni/sdk";
import type { AuthenticatedRequest } from "../middleware/auth.js";

interface AgentRunRow {
  id: string;
  user_id: string;
  hub_id: string | null;
  thread_id: string | null;
  title: string | null;
  goal: string;
  status: string;
  plan: string;
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
  started_at: string | null;
  finished_at: string | null;
}

interface AgentStepRow {
  id: string;
  run_id: string;
  seq: number;
  iter: number;
  kind: string;
  tool_name: string | null;
  tool_args: string | null;
  status: string | null;
  content: string | null;
  summary: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: string;
}

function serializeRun(row: AgentRunRow) {
  return { ...row, plan: fromJson<unknown[]>(row.plan) ?? [] };
}

function serializeStep(row: AgentStepRow) {
  return { ...row, tool_args: fromJson<Record<string, unknown>>(row.tool_args) };
}

export async function agentRoutes(app: FastifyInstance) {
  // ── GET /api/agent/runs ──
  app.get("/api/agent/runs", async (request) => {
    const { userId } = request as AuthenticatedRequest;
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(parseInt(query.limit ?? "50", 10) || 50, 1), 200);
    const runs = all<AgentRunRow>(
      `SELECT id, user_id, hub_id, thread_id, title, goal, status, plan, model,
              iter_count, max_iterations, budget_usd, cost_usd, input_tokens,
              output_tokens, final_output, error, created_at, started_at, finished_at
         FROM agent_runs
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
      userId,
      limit,
    );
    return { success: true, data: { runs: runs.map(serializeRun) } };
  });

  // ── GET /api/agent/runs/:id ──
  app.get("/api/agent/runs/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const runRow = one<AgentRunRow>(
      `SELECT id, user_id, hub_id, thread_id, title, goal, status, plan, model,
              iter_count, max_iterations, budget_usd, cost_usd, input_tokens,
              output_tokens, final_output, error, created_at, started_at, finished_at
         FROM agent_runs
        WHERE id = ? AND user_id = ?`,
      id,
      userId,
    );
    if (!runRow) {
      return reply
        .status(404)
        .send({ success: false, error: "Run not found", code: "not_found" });
    }
    const steps = all<AgentStepRow>(
      `SELECT id, run_id, seq, iter, kind, tool_name, tool_args, status, content,
              summary, cost_usd, duration_ms, created_at
         FROM agent_steps
        WHERE run_id = ?
        ORDER BY seq ASC`,
      id,
    );
    return {
      success: true,
      data: { ...serializeRun(runRow), steps: steps.map(serializeStep) },
    };
  });
}
