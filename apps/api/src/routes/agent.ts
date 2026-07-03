// Super Agent REST + SSE. The engine (orchestrator) runs in-process,
// fire-and-forget; runs are durable in agent_runs/agent_steps and streamed
// over SSE with Last-Event-ID replay.
import type { FastifyInstance } from "fastify";
import { all, fromJson, nowISO, one, run as dbRun, uuid } from "@omni/sdk";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { openSSE } from "../lib/sse.js";
import {
  abortRun,
  isRunning,
  resumeRun,
  startRun,
  TERMINAL_STATUSES,
} from "../agent/orchestrator.js";
import { loadStepsAfter, updateRun } from "../agent/persistence.js";
import { subscribe, type AgentEvent } from "../agent/run-bus.js";

interface AgentRunRow {
  id: string;
  user_id: string;
  hub_id: string | null;
  thread_id: string | null;
  title: string | null;
  goal: string;
  status: string;
  plan: string;
  pending_confirmation: string | null;
  model: string | null;
  iter_count: number;
  max_iterations: number;
  budget_usd: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  final_output: string | null;
  error: string | null;
  resumable: number;
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
  full_content_path: string | null;
  summary: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: string;
}

const RUN_COLS = `id, user_id, hub_id, thread_id, title, goal, status, plan,
  pending_confirmation, model, iter_count, max_iterations, budget_usd, cost_usd,
  input_tokens, output_tokens, final_output, error, resumable, created_at,
  started_at, finished_at`;

function serializeRun(row: AgentRunRow) {
  return {
    ...row,
    plan: fromJson<unknown[]>(row.plan) ?? [],
    pending_confirmation: fromJson<Record<string, unknown>>(row.pending_confirmation),
  };
}

function serializeStep(row: AgentStepRow) {
  return {
    ...row,
    tool_args: fromJson<Record<string, unknown>>(row.tool_args),
    // The exact SSE event is stored in `content` for replay; expose it parsed.
    event: fromJson<Record<string, unknown>>(row.content),
  };
}

function loadOwnedRun(id: string, userId: string): AgentRunRow | undefined {
  return one<AgentRunRow>(
    `SELECT ${RUN_COLS} FROM agent_runs WHERE id = ? AND user_id = ?`,
    id,
    userId,
  );
}

function runStatusEvent(row: AgentRunRow): AgentEvent {
  return {
    type: "run_status",
    status: row.status,
    iter: row.iter_count,
    cost_usd: row.cost_usd,
    budget_usd: row.budget_usd,
  };
}

const CreateSchema = z.object({
  goal: z.string().min(1).max(4000),
  hub_id: z.string().optional(),
  thread_id: z.string().optional(),
  model: z.string().optional(),
  budget_usd: z.number().positive().max(50).optional(),
});

const ConfirmSchema = z.object({
  card_id: z.string().min(1),
  action: z.enum(["confirm", "skip"]),
  answer: z.string().max(4000).optional(),
});

export async function agentRoutes(app: FastifyInstance) {
  // ── GET /api/agent/runs ──
  app.get("/api/agent/runs", async (request) => {
    const { userId } = request as AuthenticatedRequest;
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(parseInt(query.limit ?? "50", 10) || 50, 1), 200);
    const runs = all<AgentRunRow>(
      `SELECT ${RUN_COLS} FROM agent_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      userId,
      limit,
    );
    return { success: true, data: { runs: runs.map(serializeRun) } };
  });

  // ── POST /api/agent/runs ── create + start (fire-and-forget)
  app.post("/api/agent/runs", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const parsed = CreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const { goal, hub_id, thread_id, model, budget_usd } = parsed.data;
    const id = uuid();
    const title = goal.replace(/\s+/g, " ").trim().slice(0, 120);
    dbRun(
      `INSERT INTO agent_runs (id, user_id, hub_id, thread_id, title, goal, status, model, budget_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      id,
      userId,
      hub_id ?? null,
      thread_id ?? null,
      title,
      goal,
      model ?? null,
      budget_usd ?? 1.5,
      nowISO(),
    );
    // Fire-and-forget; the orchestrator owns its AbortController.
    void startRun(id).catch((err) => {
      request.log.error({ err, runId: id }, "[agent] startRun crashed");
    });
    const row = loadOwnedRun(id, userId);
    return reply.status(201).send({ success: true, data: serializeRun(row!) });
  });

  // ── GET /api/agent/runs/:id ── detail + steps
  app.get("/api/agent/runs/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const row = loadOwnedRun(id, userId);
    if (!row) {
      return reply.status(404).send({ success: false, error: "Run not found", code: "not_found" });
    }
    const steps = all<AgentStepRow>(
      `SELECT id, run_id, seq, iter, kind, tool_name, tool_args, status, content,
              full_content_path, summary, cost_usd, duration_ms, created_at
         FROM agent_steps WHERE run_id = ? ORDER BY seq ASC`,
      id,
    );
    return {
      success: true,
      data: { ...serializeRun(row), steps: steps.map(serializeStep) },
    };
  });

  // ── GET /api/agent/runs/:id/stream ── subscribe-first replay + live tail
  app.get("/api/agent/runs/:id/stream", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    // Validate + ownership BEFORE hijacking so a bad request still 404s.
    const row = loadOwnedRun(id, userId);
    if (!row) {
      return reply.status(404).send({ success: false, error: "Run not found", code: "not_found" });
    }

    const headerId = request.headers["last-event-id"];
    const q = request.query as { after?: string };
    const rawAfter = (Array.isArray(headerId) ? headerId[0] : headerId) ?? q.after ?? "0";
    let after = parseInt(rawAfter, 10);
    if (!Number.isFinite(after) || after < 0) after = 0;

    const sse = openSSE(request, reply);
    const seen = new Set<number>();
    const buffer: AgentEvent[] = [];
    let replaying = true;

    const forward = (evt: AgentEvent) => {
      if (typeof evt.seq === "number") {
        if (evt.seq <= after || seen.has(evt.seq)) return;
        seen.add(evt.seq);
        sse.send(evt, evt.seq);
      } else {
        sse.send(evt); // delta / run_status — no id
      }
    };

    // 1) Subscribe FIRST so nothing emitted during replay is lost.
    const unsub = subscribe(id, (evt) => {
      if (replaying) buffer.push(evt);
      else forward(evt);
    });
    sse.onClose(() => unsub());

    // 2) Replay persisted steps > after.
    const steps = loadStepsAfter(id, after);
    for (const s of steps) {
      const evt = fromJson<AgentEvent>(s.content);
      if (!evt) continue;
      seen.add(s.seq);
      sse.send(evt, s.seq);
      after = Math.max(after, s.seq);
    }

    // 3) Drain events buffered during replay, then go live.
    replaying = false;
    for (const evt of buffer) forward(evt);

    // 4) If already terminal, emit a final status and close.
    const fresh = loadOwnedRun(id, userId);
    if (fresh && TERMINAL_STATUSES.has(fresh.status)) {
      sse.send(runStatusEvent(fresh));
      sse.send({ type: "close" });
      unsub();
      sse.close();
    }
    return reply;
  });

  // ── POST /api/agent/runs/:id/confirm ──
  app.post("/api/agent/runs/:id/confirm", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const parsed = ConfirmSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const row = loadOwnedRun(id, userId);
    if (!row) {
      return reply.status(404).send({ success: false, error: "Run not found", code: "not_found" });
    }
    if (row.status !== "awaiting_confirmation") {
      return reply
        .status(409)
        .send({ success: false, error: "Run is not awaiting confirmation", code: "conflict" });
    }
    const pc = fromJson<{ card_id?: string }>(row.pending_confirmation);
    if (!pc || pc.card_id !== parsed.data.card_id) {
      return reply
        .status(409)
        .send({ success: false, error: "Confirmation card mismatch", code: "conflict" });
    }
    void resumeRun(id, { action: parsed.data.action, answer: parsed.data.answer }).catch((err) => {
      request.log.error({ err, runId: id }, "[agent] resume after confirm crashed");
    });
    return { success: true, data: { ok: true } };
  });

  // ── POST /api/agent/runs/:id/cancel ──
  app.post("/api/agent/runs/:id/cancel", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const row = loadOwnedRun(id, userId);
    if (!row) {
      return reply.status(404).send({ success: false, error: "Run not found", code: "not_found" });
    }
    if (TERMINAL_STATUSES.has(row.status)) {
      return { success: true, data: serializeRun(row) };
    }
    updateRun(id, { cancel_requested: 1 });
    const wasLive = abortRun(id);
    if (!wasLive) {
      // No in-process loop (suspended / queued) — transition directly.
      updateRun(id, { status: "cancelled", finished_at: nowISO(), resumable: 0, cancel_requested: 0 });
    }
    return { success: true, data: serializeRun(loadOwnedRun(id, userId)!) };
  });

  // ── POST /api/agent/runs/:id/pause ──
  app.post("/api/agent/runs/:id/pause", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const row = loadOwnedRun(id, userId);
    if (!row) {
      return reply.status(404).send({ success: false, error: "Run not found", code: "not_found" });
    }
    if (TERMINAL_STATUSES.has(row.status) || row.status === "paused") {
      return { success: true, data: serializeRun(row) };
    }
    updateRun(id, { pause_requested: 1 });
    return { success: true, data: serializeRun(loadOwnedRun(id, userId)!) };
  });

  // ── POST /api/agent/runs/:id/resume ──
  app.post("/api/agent/runs/:id/resume", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const row = loadOwnedRun(id, userId);
    if (!row) {
      return reply.status(404).send({ success: false, error: "Run not found", code: "not_found" });
    }
    const resumable = row.status === "paused" || (row.status === "failed" && row.resumable === 1);
    if (!resumable) {
      return reply
        .status(409)
        .send({ success: false, error: "Run is not resumable", code: "conflict" });
    }
    if (isRunning(id)) {
      return { success: true, data: serializeRun(row) };
    }
    void resumeRun(id).catch((err) => {
      request.log.error({ err, runId: id }, "[agent] resume crashed");
    });
    return { success: true, data: serializeRun(loadOwnedRun(id, userId)!) };
  });
}
