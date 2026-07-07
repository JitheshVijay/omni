// Workflow DAG runner (Phase 4).
//
// executeWorkflowRun(runId) loads the run's workflow graph, orders nodes
// topologically (Kahn), and executes them sequentially in that order. Four
// node types: agent_task (spawns a full Super Agent run and polls it),
// generate (any registered generator), search (Exa stitch, mirroring the
// agent's web_search tool), read_url (readable-article extraction).
//
// {{previous}} / {{input}} templating: string config values are templated
// with the joined upstream outputs and the run's optional input string.
//
// Failure policy (v1): a failed node marks every downstream-dependent node
// skipped; nodes on independent branches still execute best-effort; the run
// finishes 'failed' if any node failed. There is no retry.
//
// Progress streaming mirrors the agent engine's persist-before-emit rule:
// each workflow_run_steps row is written, THEN its wf_step event is
// published on the tiny in-process bus below (deliberately separate from
// agent/run-bus.ts — a workflow run and its inner agent runs are distinct
// stream keys).
import { z } from "zod";
import {
  MODELS,
  fromJson,
  fetchUrlArticle,
  getExaContents,
  getLastUsage,
  logger,
  nowISO,
  one,
  openai,
  run as dbRun,
  searchExa,
  toJson,
  uuid,
} from "@omni/sdk";
import { getGenerator } from "../generators/registry.js";
import { abortRun, startRun, TERMINAL_STATUSES } from "../agent/orchestrator.js";

// ─── graph shapes + node config schemas ──────────────────────────────

export const WORKFLOW_NODE_TYPES = ["agent_task", "generate", "search", "read_url"] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export const AgentTaskConfigSchema = z.object({
  goal: z.string().min(1).max(8000),
  budget_usd: z.number().positive().max(20).default(0.5),
  max_iterations: z.number().int().min(1).max(40).default(15),
});

export const GenerateConfigSchema = z.object({
  generator: z.string().min(1).max(40),
  // String values support {{previous}}/{{input}}; non-strings pass through.
  input: z.record(z.unknown()).default({}),
});

export const SearchConfigSchema = z.object({
  query: z.string().min(1).max(2000),
  num_results: z.number().int().min(1).max(8).default(6),
});

export const ReadUrlConfigSchema = z.object({
  url: z.string().min(1).max(2000),
});

export const NODE_CONFIG_SCHEMAS: Record<WorkflowNodeType, z.ZodTypeAny> = {
  agent_task: AgentTaskConfigSchema,
  generate: GenerateConfigSchema,
  search: SearchConfigSchema,
  read_url: ReadUrlConfigSchema,
};

const GraphShapeSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        type: z.enum(WORKFLOW_NODE_TYPES),
        config: z.record(z.unknown()).default({}),
      }),
    )
    .max(50),
  edges: z
    .array(z.object({ from: z.string().min(1), to: z.string().min(1) }))
    .max(200),
});

/**
 * Validate a raw graph payload: shape, unique node ids, per-type config
 * schemas, and edge endpoints. Returns the normalized graph (configs keep
 * the caller's values; zod defaults are applied at execution time so a
 * saved graph stays exactly what the editor sent).
 */
export function validateGraph(raw: unknown): { graph: WorkflowGraph } | { error: string } {
  const parsed = GraphShapeSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `Invalid graph: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim() };
  }
  const { nodes, edges } = parsed.data;
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) return { error: `Duplicate node id "${node.id}"` };
    ids.add(node.id);
    const check = NODE_CONFIG_SCHEMAS[node.type].safeParse(node.config);
    if (!check.success) {
      const issue = check.error.issues[0];
      return {
        error: `Node "${node.id}" (${node.type}): ${issue?.path.join(".") ?? "config"} ${issue?.message ?? "is invalid"}`,
      };
    }
  }
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      return { error: `Edge ${edge.from} → ${edge.to} references a missing node` };
    }
    if (edge.from === edge.to) return { error: `Node "${edge.from}" cannot connect to itself` };
  }
  return { graph: { nodes, edges } };
}

// ─── pure helpers (unit-tested) ──────────────────────────────────────

/**
 * Kahn's algorithm over the graph. Returns node ids in a deterministic
 * topological order (ready nodes processed in nodes[] order). Throws when
 * the graph contains a cycle.
 */
export function topologicalOrder(graph: WorkflowGraph): string[] {
  const indegree = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>();
  const seenEdges = new Set<string>();
  for (const e of graph.edges) {
    const key = `${e.from}→${e.to}`;
    if (seenEdges.has(key) || !indegree.has(e.from) || !indegree.has(e.to)) continue;
    seenEdges.add(key);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    const list = out.get(e.from) ?? [];
    list.push(e.to);
    out.set(e.from, list);
  }
  const queue = graph.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of out.get(id) ?? []) {
      const d = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== graph.nodes.length) {
    throw new Error("Workflow graph contains a cycle");
  }
  return order;
}

/** Direct upstream node ids of a node, in edges[] order (deduped). */
export function upstreamOf(graph: WorkflowGraph, nodeId: string): string[] {
  const ups: string[] = [];
  for (const e of graph.edges) {
    if (e.to === nodeId && !ups.includes(e.from)) ups.push(e.from);
  }
  return ups;
}

export interface TemplateVars {
  previous?: string;
  input?: string;
}

/** Replace {{previous}} and {{input}} tokens (whitespace-tolerant). */
export function applyTemplate(template: string, vars: TemplateVars): string {
  return template
    .replace(/\{\{\s*previous\s*\}\}/g, vars.previous ?? "")
    .replace(/\{\{\s*input\s*\}\}/g, vars.input ?? "");
}

/** Template every top-level string value of an object (for generate input). */
export function templateStringValues(
  obj: Record<string, unknown>,
  vars: TemplateVars,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "string" ? applyTemplate(v, vars) : v;
  }
  return out;
}

/** Compact node output persisted to workflow_run_steps.output. */
export interface NodeOutput {
  preview: string;
  text?: string;
  artifact_id?: string;
  kind?: string;
  title?: string;
  agent_run_id?: string;
}

/** What downstream {{previous}} sees for one upstream output. */
export function outputText(output: NodeOutput | null | undefined): string {
  if (!output) return "";
  return output.text ?? output.preview ?? output.title ?? "";
}

/** Join the upstream outputs into the {{previous}} value (two newlines). */
export function previousFromUpstream(outputs: Array<NodeOutput | null | undefined>): string {
  return outputs
    .map((o) => outputText(o).trim())
    .filter(Boolean)
    .join("\n\n");
}

// ─── in-process run event bus (separate from agent/run-bus) ──────────

export type WorkflowEvent = Record<string, unknown> & { type: string };
type WfListener = (event: WorkflowEvent) => void;

const buses = new Map<string, Set<WfListener>>();

/** Subscribe to a workflow run's live events. Returns unsubscribe. */
export function subscribeWorkflowRun(runId: string, cb: WfListener): () => void {
  let set = buses.get(runId);
  if (!set) {
    set = new Set();
    buses.set(runId, set);
  }
  set.add(cb);
  return () => {
    const s = buses.get(runId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) buses.delete(runId);
  };
}

function publish(runId: string, event: WorkflowEvent): void {
  const set = buses.get(runId);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb(event);
    } catch {
      /* listener threw; keep fanning out */
    }
  }
}

// ─── row shapes + serialization ──────────────────────────────────────

export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  user_id: string;
  status: string;
  trigger: string;
  error: string | null;
  cost_usd: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface WorkflowRunStepRow {
  id: string;
  run_id: string;
  user_id: string;
  node_id: string;
  seq: number;
  node_type: string;
  status: string;
  output: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface WorkflowStepPayload extends Omit<WorkflowRunStepRow, "output" | "user_id"> {
  output: NodeOutput | null;
}

export function serializeWorkflowStep(row: WorkflowRunStepRow): WorkflowStepPayload {
  const { user_id: _userId, ...rest } = row;
  return { ...rest, output: fromJson<NodeOutput>(row.output) };
}

function loadStep(stepId: string): WorkflowRunStepRow {
  return one<WorkflowRunStepRow>(
    "SELECT * FROM workflow_run_steps WHERE id = ?",
    stepId,
  ) as WorkflowRunStepRow;
}

function publishStep(runId: string, stepId: string): void {
  publish(runId, { type: "wf_step", runId, step: serializeWorkflowStep(loadStep(stepId)) });
}

function publishRunStatus(run: WorkflowRunRow): void {
  publish(run.id, {
    type: "wf_run_status",
    runId: run.id,
    status: run.status,
    cost_usd: run.cost_usd,
    error: run.error,
  });
}

export const WORKFLOW_RUN_TERMINAL = new Set(["completed", "failed", "cancelled"]);

// ─── node execution ──────────────────────────────────────────────────

const PREVIEW_CHARS = 240;
const AGENT_POLL_MS = 2_000;
const AGENT_CAP_MS = 10 * 60_000;
// A single generate node must not run unbounded — a stalled LLM/image/TTS
// provider would otherwise wedge the whole workflow run at 'running' forever.
const GEN_CAP_MS = 8 * 60_000;
const READ_URL_MAX_CHARS = 12_000;
const AGENT_TEXT_MAX_CHARS = 4_000;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

// Strip NUL/C0/C1 control chars (keep tab/newline/CR) — same rule as the
// agent's builtin tools, so stitched web text can't corrupt downstream JSON.
function sanitize(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) {
      out += s[i];
      continue;
    }
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue;
    out += s[i];
  }
  return out.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface NodeCtx {
  runId: string;
  userId: string;
  /** Accumulate best-effort cost as soon as it is known (kept on failure). */
  addCost: (usd: number) => void;
  /** Publish a transient sub-progress label for the running step. */
  onProgress: (label: string) => void;
}

async function runAgentTaskNode(
  config: z.infer<typeof AgentTaskConfigSchema>,
  vars: TemplateVars,
  ctx: NodeCtx,
): Promise<NodeOutput> {
  const goal = applyTemplate(config.goal, vars).trim();
  if (!goal) throw new Error("agent_task goal is empty after templating");
  const agentRunId = uuid();
  const title = goal.replace(/\s+/g, " ").trim().slice(0, 120);
  // Same insert shape as POST /api/agent/runs (routes/agent.ts), plus the
  // node's max_iterations cap.
  dbRun(
    // interactive = 0: unattended, so the agent gets no ask_user and is told to
    // assume-and-proceed rather than suspend (which a workflow can't answer).
    `INSERT INTO agent_runs (id, user_id, hub_id, thread_id, title, goal, status, model, budget_usd, max_iterations, interactive, created_at)
     VALUES (?, ?, NULL, NULL, ?, ?, 'queued', NULL, ?, ?, 0, ?)`,
    agentRunId,
    ctx.userId,
    title,
    goal,
    config.budget_usd,
    config.max_iterations,
    nowISO(),
  );
  void startRun(agentRunId).catch((err) => {
    logger.error({ err, agentRunId }, "[workflow] agent startRun crashed");
  });
  ctx.onProgress(`Agent run ${agentRunId} started`);

  const deadline = Date.now() + AGENT_CAP_MS;
  let lastCost = 0;
  for (;;) {
    await sleep(AGENT_POLL_MS);
    const ar = one<{ status: string; final_output: string | null; cost_usd: number; error: string | null }>(
      "SELECT status, final_output, cost_usd, error FROM agent_runs WHERE id = ?",
      agentRunId,
    );
    if (!ar) throw new Error("Agent run row disappeared");
    if (ar.cost_usd > lastCost) {
      ctx.addCost(ar.cost_usd - lastCost);
      lastCost = ar.cost_usd;
    }
    if (TERMINAL_STATUSES.has(ar.status)) {
      if (ar.status !== "completed") {
        throw new Error(ar.error || `Agent run ${ar.status}`);
      }
      const text = (ar.final_output ?? "").slice(0, AGENT_TEXT_MAX_CHARS);
      return { agent_run_id: agentRunId, text, preview: preview(text || "Agent run completed") };
    }
    // Workflows are unattended: a run that suspends for confirmation would
    // hang until the cap, so fail it fast instead.
    if (ar.status === "awaiting_confirmation" || ar.status === "paused") {
      abortRun(agentRunId);
      throw new Error("Agent run suspended for user input — not supported inside workflows");
    }
    if (Date.now() > deadline) {
      abortRun(agentRunId);
      throw new Error("Agent task exceeded the 10-minute cap");
    }
  }
}

async function runGenerateNode(
  config: z.infer<typeof GenerateConfigSchema>,
  vars: TemplateVars,
  ctx: NodeCtx,
): Promise<NodeOutput> {
  const gen = getGenerator(config.generator);
  if (!gen) throw new Error(`Unknown generator "${config.generator}"`);
  const templated = templateStringValues(config.input, vars);
  const parsed = gen.inputSchema.safeParse(templated);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Invalid ${config.generator} input: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim(),
    );
  }
  const usageBefore = getLastUsage();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GEN_CAP_MS);
  const artifact = await gen
    .run(parsed.data, {
      userId: ctx.userId,
      signal: ac.signal,
      emit: (e) => {
        if (e.type === "status") ctx.onProgress(e.label);
      },
    })
    .finally(() => clearTimeout(timer));
  // Best-effort cost: getLastUsage() reflects the most recent LLM call; only
  // count it when the generator actually produced a new usage record.
  const usageAfter = getLastUsage();
  if (usageAfter && usageAfter !== usageBefore) ctx.addCost(usageAfter.cost_usd);
  return {
    artifact_id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    preview: `${artifact.kind}: ${artifact.title}`,
  };
}

async function runSearchNode(
  config: z.infer<typeof SearchConfigSchema>,
  vars: TemplateVars,
): Promise<NodeOutput> {
  const query = applyTemplate(config.query, vars).trim();
  if (!query) throw new Error("search query is empty after templating");

  // Primary: Exa search → contents stitch (mirrors agent web_search).
  const results = await searchExa(query, { numResults: config.num_results });
  if (results.length > 0) {
    const urls = results.map((r) => r.url).slice(0, config.num_results);
    const contents = await getExaContents(urls, { maxCharactersPerUrl: 700 });
    const byUrl = new Map(contents.map((c) => [c.url, c.text]));
    const blocks = results.slice(0, config.num_results).map((r, i) => {
      const body = byUrl.get(r.url) ?? r.snippet ?? "";
      return `[${i + 1}] ${r.title}\n${r.url}\n${sanitize(body).slice(0, 700)}`;
    });
    const text = `Search results for "${query}":\n\n${blocks.join("\n\n")}`;
    return { text, preview: preview(text) };
  }

  // Fallback: the :online model reads the web (same as the agent tool).
  try {
    const resp = (await openai.chat.completions.create({
      model: MODELS.cheap_online,
      messages: [
        {
          role: "system",
          content:
            "Answer the user's search query concisely from current web results. End with a short list of the source URLs you used.",
        },
        { role: "user", content: query },
      ],
      max_tokens: 700,
    } as never)) as { choices?: Array<{ message?: { content?: string | null } }> };
    const text = sanitize(resp.choices?.[0]?.message?.content ?? "");
    if (!text) return { text: `No web results found for "${query}".`, preview: "No web results found." };
    const answer = `Web answer for "${query}":\n\n${text}`;
    return { text: answer, preview: preview(answer) };
  } catch (err) {
    logger.warn({ err: (err as Error).message, query }, "[workflow] search fallback failed");
    return { text: `Web search is currently unavailable for "${query}".`, preview: "Web search unavailable." };
  }
}

async function runReadUrlNode(
  config: z.infer<typeof ReadUrlConfigSchema>,
  vars: TemplateVars,
): Promise<NodeOutput> {
  const url = applyTemplate(config.url, vars).trim();
  if (!/^https?:\/\//i.test(url)) throw new Error(`read_url needs a valid http(s) URL, got "${url.slice(0, 120)}"`);
  const article = await fetchUrlArticle(url);
  if (!article) {
    throw new Error(`Could not extract readable content from ${url} (paywalled, JS-rendered, or not an article)`);
  }
  const text = `# ${article.title}\n(${url})\n\n${sanitize(article.text)}`.slice(0, READ_URL_MAX_CHARS);
  return { text, title: article.title, preview: preview(text) };
}

async function executeNode(node: WorkflowNode, vars: TemplateVars, ctx: NodeCtx): Promise<NodeOutput> {
  switch (node.type) {
    case "agent_task":
      return runAgentTaskNode(AgentTaskConfigSchema.parse(node.config), vars, ctx);
    case "generate":
      return runGenerateNode(GenerateConfigSchema.parse(node.config), vars, ctx);
    case "search":
      return runSearchNode(SearchConfigSchema.parse(node.config), vars);
    case "read_url":
      return runReadUrlNode(ReadUrlConfigSchema.parse(node.config), vars);
    default:
      throw new Error(`Unknown node type "${node.type as string}"`);
  }
}

// ─── the runner ──────────────────────────────────────────────────────

export interface ExecuteWorkflowRunOptions {
  /** Optional run input for {{input}} templating. In-memory only (v1) —
   *  workflow_runs has no input column, so a restart loses it. */
  input?: string;
}

export async function executeWorkflowRun(
  runId: string,
  opts: ExecuteWorkflowRunOptions = {},
): Promise<void> {
  const run = one<WorkflowRunRow>("SELECT * FROM workflow_runs WHERE id = ?", runId);
  if (!run) {
    logger.warn({ runId }, "[workflow] executeWorkflowRun: run not found");
    return;
  }
  if (run.status !== "queued") {
    logger.warn({ runId, status: run.status }, "[workflow] run is not queued; skipping");
    return;
  }
  const wf = one<{ id: string; graph: string }>(
    "SELECT id, graph FROM workflows WHERE id = ?",
    run.workflow_id,
  );

  const finishRun = (status: "completed" | "failed", error: string | null, cost: number) => {
    dbRun(
      "UPDATE workflow_runs SET status = ?, error = ?, cost_usd = ?, finished_at = ? WHERE id = ?",
      status,
      error,
      Math.round(cost * 1_000_000) / 1_000_000,
      nowISO(),
      runId,
    );
    const fresh = one<WorkflowRunRow>("SELECT * FROM workflow_runs WHERE id = ?", runId)!;
    publishRunStatus(fresh);
    publish(runId, { type: "close" });
  };

  const startedAt = nowISO();
  dbRun("UPDATE workflow_runs SET status = 'running', started_at = ? WHERE id = ?", startedAt, runId);
  dbRun("UPDATE workflows SET last_run_at = ? WHERE id = ?", startedAt, run.workflow_id);
  publishRunStatus({ ...run, status: "running" });

  if (!wf) {
    finishRun("failed", "Workflow was deleted", 0);
    return;
  }
  const graph = fromJson<WorkflowGraph>(wf.graph) ?? { nodes: [], edges: [] };
  if (graph.nodes.length === 0) {
    finishRun("failed", "Workflow has no steps", 0);
    return;
  }

  let order: string[];
  try {
    order = topologicalOrder(graph);
  } catch (err) {
    finishRun("failed", (err as Error).message, 0);
    return;
  }

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const outputs = new Map<string, NodeOutput>();
  const deadEnds = new Set<string>(); // failed or skipped — poisons downstream
  let cost = 0;
  let firstError: string | null = null;
  let seq = 0;

  try {
  for (const nodeId of order) {
    const node = nodeById.get(nodeId)!;
    seq += 1;
    const stepId = uuid();
    const upstream = upstreamOf(graph, nodeId);

    if (upstream.some((u) => deadEnds.has(u))) {
      dbRun(
        `INSERT INTO workflow_run_steps (id, run_id, user_id, node_id, seq, node_type, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'skipped', ?, ?)`,
        stepId,
        runId,
        run.user_id,
        nodeId,
        seq,
        node.type,
        "Skipped: an upstream step failed.",
        nowISO(),
      );
      publishStep(runId, stepId);
      deadEnds.add(nodeId);
      continue;
    }

    dbRun(
      `INSERT INTO workflow_run_steps (id, run_id, user_id, node_id, seq, node_type, status, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      stepId,
      runId,
      run.user_id,
      nodeId,
      seq,
      node.type,
      nowISO(),
      nowISO(),
    );
    publishStep(runId, stepId);

    const ctx: NodeCtx = {
      runId,
      userId: run.user_id,
      addCost: (usd) => {
        if (!Number.isFinite(usd) || usd <= 0) return;
        cost += usd;
        dbRun(
          "UPDATE workflow_runs SET cost_usd = ? WHERE id = ?",
          Math.round(cost * 1_000_000) / 1_000_000,
          runId,
        );
      },
      onProgress: (label) => {
        publish(runId, { type: "wf_step_progress", runId, node_id: nodeId, seq, label });
      },
    };

    try {
      const vars: TemplateVars = {
        previous: previousFromUpstream(upstream.map((u) => outputs.get(u))),
        input: opts.input ?? "",
      };
      const output = await executeNode(node, vars, ctx);
      outputs.set(nodeId, output);
      dbRun(
        "UPDATE workflow_run_steps SET status = 'ok', output = ?, finished_at = ? WHERE id = ?",
        toJson(output),
        nowISO(),
        stepId,
      );
    } catch (err) {
      const message = (err as Error).message || "Step failed";
      logger.warn({ err, runId, nodeId, type: node.type }, "[workflow] step failed");
      firstError ??= `Step "${nodeId}" (${node.type}): ${message}`;
      deadEnds.add(nodeId);
      dbRun(
        "UPDATE workflow_run_steps SET status = 'error', error = ?, finished_at = ? WHERE id = ?",
        message.slice(0, 2000),
        nowISO(),
        stepId,
      );
    }
    publishStep(runId, stepId);
  }

  finishRun(firstError ? "failed" : "completed", firstError, cost);
  } catch (err) {
    // Any throw outside per-node handling (DB write, publish, unexpected) must
    // still terminate the run; otherwise it stays 'running' forever — nothing
    // reclaims a workflow_run during the process lifetime.
    logger.error({ err, runId }, "[workflow] run crashed unexpectedly");
    finishRun("failed", (err as Error).message || "Workflow run crashed", cost);
  }
}
