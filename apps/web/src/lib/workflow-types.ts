// Workflows (Phase 4) shared types + node-type metadata. Mirrors the
// backend contracts exactly:
//   • workflows / workflow_runs / workflow_run_steps rows as the REST
//     endpoints return them (apps/api/src/routes/workflows.ts), and
//   • the run-stream SSE event union published by the DAG runner
//     (apps/api/src/lib/workflow-runner.ts).
// NODE_TYPE_META drives the editor's palette, node cards, and the generic
// config form; keep field descriptors in sync with the runner's zod schemas.

import {
  AudioLines,
  Bot,
  FileText,
  Globe,
  Image as ImageIcon,
  Mic,
  Presentation,
  Search,
  Table,
  Wand2,
  type LucideIcon,
} from "lucide-react";

// ── graph ───────────────────────────────────────────────────────────────────

export type WorkflowNodeType = "agent_task" | "generate" | "search" | "read_url";

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

// ── rows ────────────────────────────────────────────────────────────────────

export type WorkflowRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type WorkflowStepStatus = "pending" | "running" | "ok" | "error" | "skipped";

export interface Workflow {
  id: string;
  user_id?: string;
  name: string;
  description: string | null;
  graph: WorkflowGraph;
  schedule: string | null;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  // list-only enrichments
  last_run_status?: WorkflowRunStatus | null;
  last_run_id?: string | null;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  user_id?: string;
  status: WorkflowRunStatus;
  trigger: "manual" | "cron";
  error: string | null;
  cost_usd: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** Compact step output: {text?, artifact_id?, agent_run_id?, preview}. */
export interface WorkflowStepOutput {
  preview: string;
  text?: string;
  artifact_id?: string;
  kind?: string;
  title?: string;
  agent_run_id?: string;
}

export interface WorkflowRunStep {
  id: string;
  run_id: string;
  node_id: string;
  seq: number;
  node_type: WorkflowNodeType | string;
  status: WorkflowStepStatus;
  output: WorkflowStepOutput | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

/** GET /api/workflows/:id: flat workflow + recent runs. */
export interface WorkflowDetail extends Workflow {
  runs: WorkflowRun[];
}

/** GET /api/workflows/templates: a curated starter template. */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  graph: WorkflowGraph;
}

/** GET /api/workflows/runs/:runId: flat run + graph snapshot + steps. */
export interface WorkflowRunDetail extends WorkflowRun {
  workflow_name: string | null;
  graph: WorkflowGraph | null;
  steps: WorkflowRunStep[];
}

// ── SSE events ──────────────────────────────────────────────────────────────

export type WorkflowEvent =
  | { type: "wf_step"; runId: string; step: WorkflowRunStep }
  | { type: "wf_step_progress"; runId: string; node_id: string; seq: number; label: string }
  | {
      type: "wf_run_status";
      runId: string;
      status: WorkflowRunStatus;
      cost_usd: number;
      error: string | null;
    }
  | { type: "close" };

export const WORKFLOW_RUN_TERMINAL: ReadonlySet<WorkflowRunStatus> = new Set<WorkflowRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return WORKFLOW_RUN_TERMINAL.has(status);
}

// ── node-type metadata (editor palette + generic config forms) ──────────────

export interface ConfigField {
  key: string;
  label: string;
  kind: "text" | "textarea" | "number" | "select";
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface NodeTypeMeta {
  type: WorkflowNodeType;
  label: string;
  description: string;
  icon: LucideIcon;
  fields: ConfigField[];
}

export const TEMPLATE_HELP = "Use {{previous}} for the previous step's output and {{input}} for the run input.";

export const GENERATOR_OPTIONS: Array<{ value: string; label: string; icon: LucideIcon }> = [
  { value: "doc", label: "Document", icon: FileText },
  { value: "image", label: "Image", icon: ImageIcon },
  { value: "tts", label: "Audio (TTS)", icon: AudioLines },
  { value: "slides", label: "Slides", icon: Presentation },
  { value: "sheet", label: "Sheet", icon: Table },
  { value: "podcast", label: "Podcast", icon: Mic },
];

/** The one input key the v1 editor's prompt textarea binds per generator. */
export const GENERATOR_PRIMARY_INPUT_KEY: Record<string, string> = {
  doc: "prompt",
  image: "prompt",
  tts: "text",
  slides: "prompt",
  sheet: "prompt",
  podcast: "prompt",
};

export const NODE_TYPE_META: Record<WorkflowNodeType, NodeTypeMeta> = {
  agent_task: {
    type: "agent_task",
    label: "Agent task",
    description: "Give the Super Agent a goal; it plans and acts across tools.",
    icon: Bot,
    fields: [
      {
        key: "goal",
        label: "Goal",
        kind: "textarea",
        placeholder: "Research {{previous}} and write a one-page brief…",
        help: TEMPLATE_HELP,
      },
      { key: "budget_usd", label: "Budget (USD)", kind: "number", placeholder: "0.50" },
      { key: "max_iterations", label: "Max iterations", kind: "number", placeholder: "15" },
    ],
  },
  generate: {
    type: "generate",
    label: "Generate",
    description: "Run any generator (doc, image, audio, slides, sheet, podcast).",
    icon: Wand2,
    // The editor renders this type with a generator select + a prompt
    // textarea bound to GENERATOR_PRIMARY_INPUT_KEY[generator]; fields here
    // exist for the node-card summary only.
    fields: [],
  },
  search: {
    type: "search",
    label: "Web search",
    description: "Search the web and pass stitched results downstream.",
    icon: Search,
    fields: [
      {
        key: "query",
        label: "Query",
        kind: "text",
        placeholder: "latest news on {{input}}",
        help: TEMPLATE_HELP,
      },
      { key: "num_results", label: "Results (1–8)", kind: "number", placeholder: "6" },
    ],
  },
  read_url: {
    type: "read_url",
    label: "Read URL",
    description: "Fetch a page and pass its readable article text downstream.",
    icon: Globe,
    fields: [
      {
        key: "url",
        label: "URL",
        kind: "text",
        placeholder: "https://example.com/article",
        help: TEMPLATE_HELP,
      },
    ],
  },
};

export const NODE_TYPE_ORDER: WorkflowNodeType[] = ["search", "read_url", "agent_task", "generate"];

/** Fresh default config when the editor appends a node of this type. */
export function defaultNodeConfig(type: WorkflowNodeType): Record<string, unknown> {
  switch (type) {
    case "agent_task":
      return { goal: "" };
    case "generate":
      return { generator: "doc", input: { prompt: "{{previous}}" } };
    case "search":
      return { query: "" };
    case "read_url":
      return { url: "" };
  }
}

/** One-line summary of a node's config for node cards + run step rows. */
export function nodeConfigSummary(type: WorkflowNodeType | string, config: Record<string, unknown>): string {
  const str = (k: string) => (typeof config[k] === "string" ? (config[k] as string) : "");
  switch (type) {
    case "agent_task":
      return str("goal") || "No goal yet";
    case "generate": {
      const generator = str("generator") || "doc";
      const input = (config.input ?? {}) as Record<string, unknown>;
      const key = GENERATOR_PRIMARY_INPUT_KEY[generator] ?? "prompt";
      const prompt = typeof input[key] === "string" ? (input[key] as string) : "";
      const genLabel = GENERATOR_OPTIONS.find((g) => g.value === generator)?.label ?? generator;
      return prompt ? `${genLabel}: ${prompt}` : genLabel;
    }
    case "search":
      return str("query") || "No query yet";
    case "read_url":
      return str("url") || "No URL yet";
    default:
      return "";
  }
}

/**
 * Order a saved graph's nodes as a linear chain: follow edges from the head
 * (topological walk); nodes the walk misses (or any non-linear leftovers)
 * are appended in stored order, so the editor never loses a node.
 */
export function chainFromGraph(graph: WorkflowGraph): WorkflowNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const indegree = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
  const next = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  }
  const queue = graph.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const seen = new Set<string>();
  const chain: WorkflowNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    chain.push(byId.get(id)!);
    for (const to of next.get(id) ?? []) {
      const d = (indegree.get(to) ?? 1) - 1;
      indegree.set(to, d);
      if (d === 0) queue.push(to);
    }
  }
  for (const n of graph.nodes) if (!seen.has(n.id)) chain.push(n);
  return chain;
}

/** Serialize the editor's linear chain back to {nodes, edges}. */
export function graphFromChain(chain: WorkflowNode[]): WorkflowGraph {
  return {
    nodes: chain.map((n) => ({ id: n.id, type: n.type, config: n.config })),
    edges: chain.slice(1).map((n, i) => ({ from: chain[i].id, to: n.id })),
  };
}

/** Loose client-side cron sanity check (server's cron.validate is authoritative). */
export function cronLooksValid(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length < 5 || fields.length > 6) return false;
  return fields.every((f) => /^[0-9*/,\-A-Za-z?#LW]+$/.test(f));
}
