// /workflows/:id — the visual chain editor. v1 builds LINEAR chains on an
// @xyflow/react canvas: "+ Add step" appends a node auto-edged from the tail
// and nodes are laid out left-to-right automatically (the runner executes
// any DAG; the editor just doesn't author branches yet). Clicking a node
// opens the right-side config panel (a generic form driven by
// NODE_TYPE_META, with a special generator-select + prompt form for
// `generate` nodes). The toolbar owns name/schedule/enabled + Save (PATCH
// graph) + Run now; recent runs list lives in the side panel.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft,
  CalendarClock,
  Check,
  Loader2,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
  TriangleAlert,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { authFetch, invalidateApi } from "@/lib/use-api";
import {
  GENERATOR_OPTIONS,
  GENERATOR_PRIMARY_INPUT_KEY,
  NODE_TYPE_META,
  NODE_TYPE_ORDER,
  TEMPLATE_HELP,
  chainFromGraph,
  cronLooksValid,
  defaultNodeConfig,
  graphFromChain,
  nodeConfigSummary,
  type ConfigField,
  type Workflow,
  type WorkflowDetail,
  type WorkflowNode,
  type WorkflowNodeType,
  type WorkflowRun,
  type WorkflowRunStatus,
} from "@/lib/workflow-types";
import { cn, formatCost, timeAgo } from "@/lib/utils";
import { useTheme } from "@/components/theme";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ── React Flow custom node ───────────────────────────────────────────────────

const NODE_W = 220;
const NODE_GAP_X = 280;

type WfFlowNodeData = { wfNode: WorkflowNode; index: number; count: number };
type WfFlowNode = Node<WfFlowNodeData, "wfNode">;

function WfNodeCard({ data, selected }: NodeProps<WfFlowNode>) {
  const meta = NODE_TYPE_META[data.wfNode.type];
  const Icon = meta.icon;
  const summary = nodeConfigSummary(data.wfNode.type, data.wfNode.config);
  return (
    <div
      style={{ width: NODE_W }}
      className={cn(
        "rounded-xl border bg-surface2 px-3 py-2.5 transition-colors",
        selected ? "border-accent ring-2 ring-accent/20" : "border-line hover:border-accent/40",
      )}
    >
      {data.index > 0 && (
        <Handle type="target" position={Position.Left} className="!size-2 !border-line !bg-surface" />
      )}
      <div className="flex items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-ink text-surface">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-ink">{meta.label}</p>
          <p className="text-[10px] text-muted">Step {data.index + 1}</p>
        </div>
      </div>
      <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-muted" title={summary}>
        {summary}
      </p>
      {data.index < data.count - 1 && (
        <Handle type="source" position={Position.Right} className="!size-2 !border-line !bg-surface" />
      )}
    </div>
  );
}

const nodeTypes = { wfNode: WfNodeCard };

function newNodeId(): string {
  return `n-${crypto.randomUUID().slice(0, 8)}`;
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function WorkflowEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { resolvedTheme } = useTheme();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [chain, setChain] = useState<WorkflowNode[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  // ── load (StrictMode-safe) ──
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const wf = await authFetch<WorkflowDetail>(`/api/workflows/${id}`);
        if (cancelled) return;
        setName(wf.name);
        setSchedule(wf.schedule ?? "");
        setEnabled(wf.enabled === 1);
        setChain(chainFromGraph(wf.graph ?? { nodes: [], edges: [] }));
        setRuns(wf.runs ?? []);
        setDirty(false);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Could not load this workflow.");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const touch = useCallback(() => {
    setDirty(true);
    setSavedTick(false);
  }, []);

  // ── chain ops ──
  const addStep = useCallback(
    (type: WorkflowNodeType) => {
      const node: WorkflowNode = { id: newNodeId(), type, config: defaultNodeConfig(type) };
      setChain((prev) => [...prev, node]);
      setSelectedId(node.id);
      touch();
    },
    [touch],
  );

  const updateNodeConfig = useCallback(
    (nodeId: string, config: Record<string, unknown>) => {
      setChain((prev) => prev.map((n) => (n.id === nodeId ? { ...n, config } : n)));
      touch();
    },
    [touch],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      // Removing from the ordered chain re-links prev → next implicitly.
      setChain((prev) => prev.filter((n) => n.id !== nodeId));
      setSelectedId((cur) => (cur === nodeId ? null : cur));
      touch();
    },
    [touch],
  );

  // ── save / run ──
  const save = useCallback(async (): Promise<boolean> => {
    if (!id || saving) return false;
    setSaving(true);
    setActionError(null);
    try {
      const wf = await authFetch<Workflow>(`/api/workflows/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim() || "Untitled workflow",
          schedule: schedule.trim() ? schedule.trim() : null,
          enabled,
          graph: graphFromChain(chain),
        }),
      });
      setSchedule(wf.schedule ?? "");
      setDirty(false);
      setSavedTick(true);
      void invalidateApi("/api/workflows");
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Save failed.");
      return false;
    } finally {
      setSaving(false);
    }
  }, [id, saving, name, schedule, enabled, chain]);

  const runNow = useCallback(async () => {
    if (!id || launching || chain.length === 0) return;
    setLaunching(true);
    setActionError(null);
    try {
      if (dirty && !(await save())) return;
      const run = await authFetch<WorkflowRun>(`/api/workflows/${id}/run`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      navigate(`/workflows/${id}/runs/${run.id}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not start the run.");
    } finally {
      setLaunching(false);
    }
  }, [id, launching, chain.length, dirty, save, navigate]);

  const deleteWorkflow = useCallback(async () => {
    if (!id) return;
    const ok = await confirm({
      title: "Delete workflow?",
      message: "The workflow, its schedule, and its run history will be removed.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await authFetch(`/api/workflows/${id}`, { method: "DELETE" });
      void invalidateApi("/api/workflows");
      navigate("/workflows");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Delete failed.");
    }
  }, [id, confirm, navigate]);

  // ── React Flow projection ──
  const flowNodes = useMemo<WfFlowNode[]>(
    () =>
      chain.map((n, i) => ({
        id: n.id,
        type: "wfNode",
        position: { x: i * NODE_GAP_X + 24, y: 60 },
        data: { wfNode: n, index: i, count: chain.length },
        draggable: false,
        selected: n.id === selectedId,
      })),
    [chain, selectedId],
  );
  const flowEdges = useMemo<Edge[]>(
    () =>
      chain.slice(1).map((n, i) => ({
        id: `e-${chain[i].id}-${n.id}`,
        source: chain[i].id,
        target: n.id,
        animated: true,
      })),
    [chain],
  );

  const selectedNode = chain.find((n) => n.id === selectedId) ?? null;
  const scheduleInvalid = schedule.trim().length > 0 && !cronLooksValid(schedule);

  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <TriangleAlert className="size-8 text-rose-500" />
        <p className="text-sm text-muted">{loadError}</p>
        <Button variant="secondary" asChild>
          <Link to="/workflows">Back to workflows</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      {/* ── toolbar ── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface2 px-4 py-2.5 pl-14 lg:pl-4">
        <Button variant="ghost" size="iconSm" asChild className="shrink-0">
          <Link to="/workflows" aria-label="All workflows">
            <ArrowLeft />
          </Link>
        </Button>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            touch();
          }}
          placeholder="Workflow name"
          maxLength={200}
          aria-label="Workflow name"
          className="h-9 w-52 font-medium md:w-64"
          disabled={loading}
        />

        <div className="relative">
          <CalendarClock className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <Input
            value={schedule}
            onChange={(e) => {
              setSchedule(e.target.value);
              touch();
            }}
            placeholder="cron, e.g. 0 9 * * 1"
            aria-label="Cron schedule"
            title={`node-cron expression — leave empty for manual-only. ${scheduleInvalid ? "Looks invalid." : ""}`}
            className={cn(
              "h-9 w-44 pl-8 font-mono text-xs",
              scheduleInvalid && "border-rose-500/60 focus-visible:ring-rose-500/40",
            )}
            disabled={loading}
          />
        </div>
        {scheduleInvalid && (
          <span className="text-[11px] text-rose-600 dark:text-rose-400">
            5 fields: min hour day month weekday
          </span>
        )}

        <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs font-medium text-muted">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => {
              setEnabled((v) => !v);
              touch();
            }}
            disabled={loading}
            className={cn(
              "relative h-5 w-9 rounded-full transition-colors",
              enabled ? "bg-accent" : "bg-ink/15",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform",
                enabled ? "translate-x-[18px]" : "translate-x-0.5",
              )}
            />
          </button>
          Enabled
        </label>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void deleteWorkflow()} disabled={loading}>
            <Trash2 />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void save()}
            disabled={loading || saving || (!dirty && !savedTick)}
          >
            {saving ? <Loader2 className="animate-spin" /> : savedTick && !dirty ? <Check /> : <Save />}
            {savedTick && !dirty ? "Saved" : "Save"}
          </Button>
          <Button size="sm" onClick={() => void runNow()} disabled={loading || launching || chain.length === 0}>
            {launching ? <Loader2 className="animate-spin" /> : <Play />}
            Run now
          </Button>
        </div>
      </div>

      {!loading && !enabled && chain.length > 0 && (
        <div className="flex items-center gap-2 border-b border-accent/30 bg-accent/[0.06] px-4 py-1.5 text-[12px] text-ink">
          <Sparkles className="size-3.5 shrink-0 text-accent" />
          <span>
            <span className="font-medium">Draft — review the steps.</span> Click a step to tweak
            it, then Save and turn it on to schedule or run.
          </span>
        </div>
      )}

      {actionError && (
        <div className="flex items-center gap-2 border-b border-rose-500/30 bg-rose-500/5 px-4 py-1.5 text-[12px] text-rose-600 dark:text-rose-400">
          <TriangleAlert className="size-3.5 shrink-0" />
          {actionError}
        </div>
      )}

      {/* ── canvas + side panel ── */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {loading ? (
            <div className="p-6">
              <Skeleton className="h-28 w-full max-w-xl rounded-xl" />
            </div>
          ) : (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              colorMode={resolvedTheme}
              onNodeClick={(_, node) => setSelectedId(node.id)}
              onPaneClick={() => setSelectedId(null)}
              nodesDraggable={false}
              nodesConnectable={false}
              deleteKeyCode={null}
              fitView
              fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
              minZoom={0.3}
              maxZoom={1.5}
              className="!bg-surface"
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
            </ReactFlow>
          )}

          {!loading && chain.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
              <WorkflowIcon className="size-8 text-muted/50" />
              <p className="text-sm font-medium text-ink">Empty workflow</p>
              <p className="max-w-xs text-xs text-muted">
                Add your first step below — steps run left to right, each feeding{" "}
                <code className="rounded bg-ink/5 px-1">{"{{previous}}"}</code> to the next.
              </p>
            </div>
          )}

          {/* + Add step (appends to the tail) */}
          {!loading && (
            <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" className="shadow-md">
                    <Plus />
                    Add step
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center" side="top">
                  {NODE_TYPE_ORDER.map((type) => {
                    const meta = NODE_TYPE_META[type];
                    const Icon = meta.icon;
                    return (
                      <DropdownMenuItem key={type} onSelect={() => addStep(type)}>
                        <Icon className="size-4 text-accent" />
                        <div className="ml-1">
                          <p className="text-[13px] font-medium">{meta.label}</p>
                          <p className="text-[11px] text-muted">{meta.description}</p>
                        </div>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        {/* ── side panel ── */}
        <aside className="flex w-80 shrink-0 flex-col overflow-y-auto scrollbar-thin border-l border-line bg-surface2">
          {selectedNode ? (
            <NodeConfigPanel
              key={selectedNode.id}
              node={selectedNode}
              onChange={(config) => updateNodeConfig(selectedNode.id, config)}
              onDelete={() => deleteNode(selectedNode.id)}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <div className="px-4 py-4">
              <p className="eyebrow">Workflow</p>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                {chain.length === 0
                  ? "Add steps to build a chain. Click a step to configure it."
                  : "Click a step on the canvas to configure it. Steps run left to right; each step's output becomes the next step's {{previous}}."}
              </p>
            </div>
          )}

          <div className="mt-auto border-t border-line px-4 py-4">
            <p className="eyebrow">Recent runs</p>
            {runs.length === 0 ? (
              <p className="mt-2 text-xs text-muted">No runs yet.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {runs.map((r) => (
                  <li key={r.id}>
                    <Link
                      to={`/workflows/${id}/runs/${r.id}`}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition hover:bg-ink/5"
                    >
                      <RunStatusDot status={r.status} />
                      <span className="text-ink">{timeAgo(r.created_at)}</span>
                      <span className="capitalize text-muted">· {r.trigger}</span>
                      {r.cost_usd > 0 && (
                        <span className="ml-auto tabular-nums text-muted">{formatCost(r.cost_usd)}</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ── run status dot (shared with the list page's palette) ────────────────────

const DOT_CLASS: Record<WorkflowRunStatus, string> = {
  queued: "bg-slate-400",
  running: "bg-amber-500 animate-pulse",
  completed: "bg-emerald-500",
  failed: "bg-rose-500",
  cancelled: "bg-slate-400",
};

function RunStatusDot({ status }: { status: WorkflowRunStatus }) {
  return <span className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[status])} title={status} />;
}

// ── node config panel ────────────────────────────────────────────────────────

function NodeConfigPanel({
  node,
  onChange,
  onDelete,
  onClose,
}: {
  node: WorkflowNode;
  onChange: (config: Record<string, unknown>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const meta = NODE_TYPE_META[node.type];
  const Icon = meta.icon;

  const setValue = (key: string, value: unknown) => {
    const next = { ...node.config };
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
    onChange(next);
  };

  return (
    <div className="px-4 py-4">
      <div className="flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-lg bg-ink text-surface">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{meta.label}</p>
          <p className="text-[11px] text-muted">{meta.description}</p>
        </div>
        <Button variant="ghost" size="iconSm" onClick={onClose} aria-label="Close panel">
          ✕
        </Button>
      </div>

      <div className="mt-4 space-y-3">
        {node.type === "generate" ? (
          <GenerateConfigForm node={node} onChange={onChange} />
        ) : (
          meta.fields.map((field) => (
            <GenericField
              key={field.key}
              field={field}
              value={node.config[field.key]}
              onChange={(v) => setValue(field.key, v)}
            />
          ))
        )}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={onDelete}
        className="mt-5 w-full text-rose-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400"
      >
        <Trash2 />
        Delete step
      </Button>
    </div>
  );
}

function GenericField({
  field,
  value,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const strValue = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  return (
    <label className="block text-xs font-medium text-muted">
      {field.label}
      {field.kind === "textarea" ? (
        <Textarea
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={5}
          className="mt-1.5 text-[13px]"
        />
      ) : (
        <Input
          type={field.kind === "number" ? "number" : "text"}
          inputMode={field.kind === "number" ? "decimal" : undefined}
          value={strValue}
          onChange={(e) => {
            if (field.kind === "number") {
              const n = Number.parseFloat(e.target.value);
              onChange(e.target.value === "" ? "" : Number.isFinite(n) ? n : e.target.value);
            } else {
              onChange(e.target.value);
            }
          }}
          placeholder={field.placeholder}
          className="mt-1.5"
        />
      )}
      {field.help && <span className="mt-1 block font-normal text-[11px] text-muted/80">{field.help}</span>}
    </label>
  );
}

// Generate nodes: generator select + one prompt textarea bound to the
// generator's primary input key ({prompt} for most, {text} for tts). Extra
// input keys a power user saved by hand are preserved untouched.
function GenerateConfigForm({
  node,
  onChange,
}: {
  node: WorkflowNode;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const generator = typeof node.config.generator === "string" ? node.config.generator : "doc";
  const input = (node.config.input ?? {}) as Record<string, unknown>;
  const primaryKey = GENERATOR_PRIMARY_INPUT_KEY[generator] ?? "prompt";
  const prompt = typeof input[primaryKey] === "string" ? (input[primaryKey] as string) : "";

  const setGenerator = (next: string) => {
    const nextKey = GENERATOR_PRIMARY_INPUT_KEY[next] ?? "prompt";
    const nextInput = { ...input };
    // Migrate the prompt text to the new generator's primary key.
    if (nextKey !== primaryKey) {
      delete nextInput[primaryKey];
      if (prompt) nextInput[nextKey] = prompt;
    }
    onChange({ ...node.config, generator: next, input: nextInput });
  };

  const setPrompt = (text: string) => {
    const nextInput = { ...input };
    if (text) nextInput[primaryKey] = text;
    else delete nextInput[primaryKey];
    onChange({ ...node.config, input: nextInput });
  };

  return (
    <>
      <label className="block text-xs font-medium text-muted">
        Generator
        <Select value={generator} onValueChange={setGenerator}>
          <SelectTrigger className="mt-1.5 w-full" aria-label="Generator">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GENERATOR_OPTIONS.map((g) => (
              <SelectItem key={g.value} value={g.value}>
                <span className="inline-flex items-center gap-2">
                  <g.icon className="size-3.5 text-muted" />
                  {g.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="block text-xs font-medium text-muted">
        {primaryKey === "text" ? "Text" : "Prompt"}
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            primaryKey === "text"
              ? "Narrate {{previous}}"
              : "Write a report based on: {{previous}}"
          }
          rows={6}
          className="mt-1.5 text-[13px]"
        />
        <span className="mt-1 block font-normal text-[11px] text-muted/80">{TEMPLATE_HELP}</span>
      </label>
    </>
  );
}
