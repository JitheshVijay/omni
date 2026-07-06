// Workflows REST + run SSE. CRUD over the workflows table (graph validated
// through the runner's zod schemas, schedules through cron.validate), manual
// run trigger (fire-and-forget into the DAG runner), and a run stream that
// replays persisted steps then live-tails the in-process workflow bus —
// a simpler cousin of the agent stream (steps update in place, so replay
// just re-sends current rows; no Last-Event-ID resume needed).
import type { FastifyInstance } from "fastify";
import cron from "node-cron";
import { z } from "zod";
import { MODELS, all, callLLMJSON, fromJson, nowISO, one, run as dbRun, toJson, uuid } from "@omni/sdk";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { openSSE } from "../lib/sse.js";
import {
  WORKFLOW_NODE_TYPES,
  WORKFLOW_RUN_TERMINAL,
  executeWorkflowRun,
  serializeWorkflowStep,
  subscribeWorkflowRun,
  validateGraph,
  type WorkflowGraph,
  type WorkflowNodeType,
  type WorkflowRunRow,
  type WorkflowRunStepRow,
} from "../lib/workflow-runner.js";
import { syncWorkflowSchedule, unscheduleWorkflow } from "../lib/workflow-cron.js";
import { WORKFLOW_TEMPLATES, getWorkflowTemplate } from "../lib/workflow-templates.js";

interface WorkflowRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  graph: string;
  schedule: string | null;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

function serializeWorkflow(row: WorkflowRow) {
  return { ...row, graph: fromJson<WorkflowGraph>(row.graph) ?? { nodes: [], edges: [] } };
}

function loadOwnedWorkflow(id: string, userId: string): WorkflowRow | undefined {
  return one<WorkflowRow>("SELECT * FROM workflows WHERE id = ? AND user_id = ?", id, userId);
}

function loadOwnedRun(runId: string, userId: string): WorkflowRunRow | undefined {
  return one<WorkflowRunRow>(
    "SELECT * FROM workflow_runs WHERE id = ? AND user_id = ?",
    runId,
    userId,
  );
}

function loadSteps(runId: string) {
  return all<WorkflowRunStepRow>(
    "SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY seq ASC",
    runId,
  ).map(serializeWorkflowStep);
}

const EMPTY_GRAPH = '{"nodes":[],"edges":[]}';

const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  graph: z.unknown().optional(),
  schedule: z.string().min(1).max(120).nullable().optional(),
  enabled: z.boolean().optional(),
});

const PatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  graph: z.unknown().optional(),
  schedule: z.string().min(1).max(120).nullable().optional(),
  enabled: z.boolean().optional(),
});

const RunSchema = z.object({
  input: z.string().max(8000).optional(),
});

const GenerateSchema = z.object({
  prompt: z.string().min(1).max(4000),
  name: z.string().min(1).max(200).optional(),
});

// ─── natural-language workflow builder ────────────────────────────────
//
// POST /api/workflows/generate turns a plain-language request into a valid
// LINEAR workflow graph via callLLMJSON, then coerces + validates it through
// the SAME schemas the CRUD routes use (validateGraph). The model is only
// trusted for the shape; edges are always rebuilt as a linear chain and
// generate configs are normalized, so most "invalid" cases are repaired
// before validation ever runs.

const MAX_GENERATED_NODES = 6;
const GENERATE_GENERATORS = ["doc", "slides", "sheet", "image"] as const;

const WORKFLOW_GENERATE_SYSTEM = `You are a workflow builder for an automation product. Convert the user's plain-language request into a LINEAR workflow: an ordered chain of steps where each step feeds its output into the next.

There are EXACTLY 4 step types. Use only these, with exactly these config fields:

1. "search" — web search. config: { "query": string }. Put {{input}} inside the query when the run should take a topic at runtime.
2. "read_url" — fetch one web page's readable text. config: { "url": string } — a full http(s) URL.
3. "agent_task" — hand an autonomous AI agent a goal; it researches and reasons across tools. config: { "goal": string }. Best for multi-step synthesis.
4. "generate" — produce the final deliverable artifact. config: { "generator": one of "doc" | "slides" | "sheet" | "image", "input": { "prompt": string } }. "doc" = written document/report, "slides" = presentation deck, "sheet" = spreadsheet/table, "image" = picture/illustration.

Chaining: every step after the first should reference the previous step's output with the token {{previous}} inside its string fields, so data flows through the chain. The run can also take an optional input string, referenced as {{input}}.

Rules:
- Return between 1 and ${MAX_GENERATED_NODES} steps. Prefer 2 to 4.
- The LAST step is almost always a "generate" step producing the deliverable the user asked for.
- Every step after the first MUST include {{previous}} in its goal/prompt/query.
- Make goals and prompts concrete and self-contained.

Return JSON in EXACTLY this shape:
{
  "name": "short workflow name",
  "description": "one sentence on what it does",
  "nodes": [
    { "id": "n1", "type": "search", "config": { "query": "latest AI news {{input}}" } },
    { "id": "n2", "type": "generate", "config": { "generator": "doc", "input": { "prompt": "Write a news brief from: {{previous}}" } } }
  ]
}`;

interface RawGeneratedNode {
  id?: unknown;
  type?: unknown;
  config?: unknown;
}

interface RawGenerated {
  name?: unknown;
  description?: unknown;
  nodes?: unknown;
}

/**
 * Coerce a raw LLM object into a candidate {name?, description?, graph}.
 * Edges are ALWAYS rebuilt as a linear chain from node order (the model is
 * unreliable at wiring), generate configs are normalized to {generator,
 * input:{prompt}}, and ids are made unique — leaving only genuinely empty
 * required fields for validateGraph to reject.
 */
function coerceGeneratedGraph(raw: RawGenerated): {
  name?: string;
  description?: string;
  graph: WorkflowGraph;
} {
  const rawNodes = Array.isArray(raw?.nodes) ? (raw.nodes as RawGeneratedNode[]) : [];
  const seen = new Set<string>();
  const nodes = rawNodes.slice(0, MAX_GENERATED_NODES).map((n, i) => {
    const type: WorkflowNodeType = WORKFLOW_NODE_TYPES.includes(n?.type as WorkflowNodeType)
      ? (n.type as WorkflowNodeType)
      : "agent_task";
    let id =
      typeof n?.id === "string" && n.id.trim() ? n.id.trim().slice(0, 80) : `n${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`.slice(0, 80);
    seen.add(id);

    const rawConfig =
      n?.config && typeof n.config === "object" ? (n.config as Record<string, unknown>) : {};
    let config: Record<string, unknown> = rawConfig;
    if (type === "generate") {
      let generator =
        typeof rawConfig.generator === "string" ? (rawConfig.generator as string) : "doc";
      if (!GENERATE_GENERATORS.includes(generator as (typeof GENERATE_GENERATORS)[number])) {
        generator = "doc";
      }
      let input: Record<string, unknown>;
      if (typeof rawConfig.input === "string") {
        input = { prompt: rawConfig.input };
      } else if (rawConfig.input && typeof rawConfig.input === "object") {
        input = { ...(rawConfig.input as Record<string, unknown>) };
      } else {
        input = {};
      }
      if (typeof input.prompt !== "string" || !(input.prompt as string).trim()) {
        input.prompt = "{{previous}}";
      }
      config = { generator, input };
    }
    return { id, type, config };
  });

  return {
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : undefined,
    description:
      typeof raw?.description === "string" && raw.description.trim()
        ? raw.description.trim()
        : undefined,
    graph: {
      nodes,
      edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
    },
  };
}

export async function workflowRoutes(app: FastifyInstance) {
  // ── GET /api/workflows ── list with last-run summary
  app.get("/api/workflows", async (request) => {
    const { userId } = request as AuthenticatedRequest;
    const rows = all<WorkflowRow & { last_run_status: string | null; last_run_id: string | null }>(
      `SELECT w.*,
              (SELECT r.status FROM workflow_runs r WHERE r.workflow_id = w.id
                ORDER BY r.created_at DESC LIMIT 1) AS last_run_status,
              (SELECT r.id FROM workflow_runs r WHERE r.workflow_id = w.id
                ORDER BY r.created_at DESC LIMIT 1) AS last_run_id
         FROM workflows w
        WHERE w.user_id = ?
        ORDER BY w.updated_at DESC`,
      userId,
    );
    return {
      success: true,
      data: {
        workflows: rows.map((r) => ({
          ...serializeWorkflow(r),
          last_run_status: r.last_run_status,
          last_run_id: r.last_run_id,
        })),
      },
    };
  });

  // ── POST /api/workflows ── create (bare row back)
  app.post("/api/workflows", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const parsed = CreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const body = parsed.data;

    let graphJson = EMPTY_GRAPH;
    if (body.graph !== undefined) {
      const checked = validateGraph(body.graph);
      if ("error" in checked) {
        return reply.status(400).send({ success: false, error: checked.error, code: "invalid_graph" });
      }
      graphJson = toJson(checked.graph)!;
    }
    if (body.schedule != null && !cron.validate(body.schedule)) {
      return reply
        .status(400)
        .send({ success: false, error: "Invalid cron expression", code: "invalid_schedule" });
    }

    const id = uuid();
    dbRun(
      `INSERT INTO workflows (id, user_id, name, description, graph, schedule, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      body.name,
      body.description ?? null,
      graphJson,
      body.schedule ?? null,
      body.enabled === false ? 0 : 1,
    );
    const row = loadOwnedWorkflow(id, userId)!;
    syncWorkflowSchedule(row);
    return reply.status(201).send({ success: true, data: serializeWorkflow(row) });
  });

  // ── GET /api/workflows/templates ── curated starter gallery
  // (static path; Fastify's radix router prefers it over /:id)
  app.get("/api/workflows/templates", async () => {
    return { success: true, data: { templates: WORKFLOW_TEMPLATES } };
  });

  // ── POST /api/workflows/templates/:id/use ── clone a template into a
  //    new, DISABLED workflow the user reviews in the editor.
  app.post("/api/workflows/templates/:id/use", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const tpl = getWorkflowTemplate(id);
    if (!tpl) {
      return reply.status(404).send({ success: false, error: "Template not found", code: "not_found" });
    }
    const checked = validateGraph(tpl.graph);
    if ("error" in checked) {
      // Shouldn't happen for curated templates; surface loudly if it does.
      return reply
        .status(500)
        .send({ success: false, error: `Template graph invalid: ${checked.error}`, code: "invalid_template" });
    }
    const wfId = uuid();
    dbRun(
      `INSERT INTO workflows (id, user_id, name, description, graph, schedule, enabled)
       VALUES (?, ?, ?, ?, ?, NULL, 0)`,
      wfId,
      userId,
      tpl.name,
      tpl.description,
      toJson(checked.graph)!,
    );
    const row = loadOwnedWorkflow(wfId, userId)!;
    return reply.status(201).send({ success: true, data: serializeWorkflow(row) });
  });

  // ── POST /api/workflows/generate ── natural-language → workflow graph
  app.post("/api/workflows/generate", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const parsed = GenerateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const { prompt, name } = parsed.data;

    let lastError = "the model did not return a usable workflow";
    for (let attempt = 0; attempt < 2; attempt++) {
      let raw: RawGenerated;
      try {
        raw = await callLLMJSON<RawGenerated>({
          system: WORKFLOW_GENERATE_SYSTEM,
          model: MODELS.default,
          maxTokens: 1500,
          prompt:
            attempt === 0
              ? `Build a workflow for this request:\n\n${prompt}`
              : `Build a workflow for this request:\n\n${prompt}\n\nYour previous attempt was rejected: ${lastError}. Return a corrected workflow as valid JSON.`,
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : "LLM call failed";
        continue;
      }

      const coerced = coerceGeneratedGraph(raw);
      const checked = validateGraph(coerced.graph);
      if ("error" in checked) {
        lastError = checked.error;
        continue;
      }

      const wfId = uuid();
      dbRun(
        `INSERT INTO workflows (id, user_id, name, description, graph, schedule, enabled)
         VALUES (?, ?, ?, ?, ?, NULL, 0)`,
        wfId,
        userId,
        (name ?? coerced.name ?? "Generated workflow").slice(0, 200),
        (coerced.description ?? "Generated from a description — review before running.").slice(0, 2000),
        toJson(checked.graph)!,
      );
      const row = loadOwnedWorkflow(wfId, userId)!;
      return reply.status(201).send({ success: true, data: serializeWorkflow(row) });
    }

    request.log.warn({ lastError }, "[workflows] generate failed after retry");
    return reply.status(422).send({
      success: false,
      error: `Could not build a valid workflow from that description: ${lastError}`,
      code: "generate_failed",
    });
  });

  // ── GET /api/workflows/:id ── flat + recent runs
  app.get("/api/workflows/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const row = loadOwnedWorkflow(id, userId);
    if (!row) {
      return reply.status(404).send({ success: false, error: "Workflow not found", code: "not_found" });
    }
    const runs = all<WorkflowRunRow>(
      `SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 10`,
      id,
    );
    return { success: true, data: { ...serializeWorkflow(row), runs } };
  });

  // ── PATCH /api/workflows/:id ──
  app.patch("/api/workflows/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const row = loadOwnedWorkflow(id, userId);
    if (!row) {
      return reply.status(404).send({ success: false, error: "Workflow not found", code: "not_found" });
    }
    const parsed = PatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const body = parsed.data;

    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.name !== undefined) {
      sets.push("name = ?");
      params.push(body.name);
    }
    if (body.description !== undefined) {
      sets.push("description = ?");
      params.push(body.description);
    }
    if (body.graph !== undefined) {
      const checked = validateGraph(body.graph);
      if ("error" in checked) {
        return reply.status(400).send({ success: false, error: checked.error, code: "invalid_graph" });
      }
      sets.push("graph = ?");
      params.push(toJson(checked.graph));
    }
    if (body.schedule !== undefined) {
      if (body.schedule != null && !cron.validate(body.schedule)) {
        return reply
          .status(400)
          .send({ success: false, error: "Invalid cron expression", code: "invalid_schedule" });
      }
      sets.push("schedule = ?");
      params.push(body.schedule);
    }
    if (body.enabled !== undefined) {
      sets.push("enabled = ?");
      params.push(body.enabled ? 1 : 0);
    }
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      params.push(nowISO());
      dbRun(`UPDATE workflows SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    }
    const fresh = loadOwnedWorkflow(id, userId)!;
    syncWorkflowSchedule(fresh);
    return { success: true, data: serializeWorkflow(fresh) };
  });

  // ── DELETE /api/workflows/:id ──
  app.delete("/api/workflows/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const row = loadOwnedWorkflow(id, userId);
    if (!row) {
      return reply.status(404).send({ success: false, error: "Workflow not found", code: "not_found" });
    }
    unscheduleWorkflow(id);
    dbRun("DELETE FROM workflows WHERE id = ?", id); // runs/steps cascade
    return { success: true, data: { deleted: true } };
  });

  // ── POST /api/workflows/:id/run ── manual trigger (fire-and-forget)
  app.post("/api/workflows/:id/run", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const row = loadOwnedWorkflow(id, userId);
    if (!row) {
      return reply.status(404).send({ success: false, error: "Workflow not found", code: "not_found" });
    }
    const parsed = RunSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const graph = fromJson<WorkflowGraph>(row.graph);
    if (!graph || graph.nodes.length === 0) {
      return reply
        .status(400)
        .send({ success: false, error: "Add at least one step before running", code: "empty_graph" });
    }

    const runId = uuid();
    dbRun(
      `INSERT INTO workflow_runs (id, workflow_id, user_id, status, trigger, created_at)
       VALUES (?, ?, ?, 'queued', 'manual', ?)`,
      runId,
      id,
      userId,
      nowISO(),
    );
    void executeWorkflowRun(runId, { input: parsed.data.input }).catch((err) => {
      request.log.error({ err, runId }, "[workflows] executeWorkflowRun crashed");
    });
    const run = loadOwnedRun(runId, userId)!;
    return reply.status(201).send({ success: true, data: run });
  });

  // ── GET /api/workflows/runs/:runId ── flat run + steps
  app.get("/api/workflows/runs/:runId", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { runId } = request.params as { runId: string };
    const run = loadOwnedRun(runId, userId);
    if (!run) {
      return reply.status(404).send({ success: false, error: "Run not found", code: "not_found" });
    }
    const wf = one<{ name: string; graph: string }>(
      "SELECT name, graph FROM workflows WHERE id = ?",
      run.workflow_id,
    );
    return {
      success: true,
      data: {
        ...run,
        workflow_name: wf?.name ?? null,
        graph: wf ? fromJson<WorkflowGraph>(wf.graph) : null,
        steps: loadSteps(runId),
      },
    };
  });

  // ── GET /api/workflows/runs/:runId/stream ── replay + live tail
  app.get("/api/workflows/runs/:runId/stream", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { runId } = request.params as { runId: string };
    // Validate ownership BEFORE hijacking so a bad request still 404s.
    const run = loadOwnedRun(runId, userId);
    if (!run) {
      return reply.status(404).send({ success: false, error: "Run not found", code: "not_found" });
    }
    const q = request.query as { after?: string };
    let after = parseInt(q.after ?? "0", 10);
    if (!Number.isFinite(after) || after < 0) after = 0;

    const sse = openSSE(request, reply);

    // 1) Subscribe FIRST so nothing emitted during replay is lost. Steps
    //    update in place (same seq goes running→ok), so the client upserts
    //    by seq; buffered duplicates are harmless.
    const buffer: Record<string, unknown>[] = [];
    let replaying = true;
    const unsub = subscribeWorkflowRun(runId, (evt) => {
      if (replaying) buffer.push(evt);
      else sse.send(evt);
    });
    sse.onClose(() => unsub());

    // 2) Replay current step rows (> after) as wf_step events.
    for (const step of loadSteps(runId)) {
      if (step.seq <= after) continue;
      sse.send({ type: "wf_step", runId, step }, step.seq);
    }

    // 3) Drain the replay buffer, then go live.
    replaying = false;
    for (const evt of buffer) sse.send(evt);

    // 4) Current status; if already terminal, close out.
    const fresh = loadOwnedRun(runId, userId)!;
    sse.send({
      type: "wf_run_status",
      runId,
      status: fresh.status,
      cost_usd: fresh.cost_usd,
      error: fresh.error,
    });
    if (WORKFLOW_RUN_TERMINAL.has(fresh.status)) {
      sse.send({ type: "close" });
      unsub();
      sse.close();
    }
    return reply;
  });
}
