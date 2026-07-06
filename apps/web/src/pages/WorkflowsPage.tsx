// /workflows — Genspark-style automation home. A centered hero + a natural-
// language builder (describe a task → POST /api/workflows/generate → the LLM
// drafts a step chain → jump into the editor to review), a "Start from a
// template" gallery (GET /api/workflows/templates → clone → editor), and the
// existing "My workflows" list with its per-row toggle / run-now controls.

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  ArrowRight,
  CalendarClock,
  ChevronRight,
  Hand,
  Loader2,
  Play,
  Plus,
  Sparkles,
  Wand2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { authFetch, invalidateApi, useApi } from "@/lib/use-api";
import {
  NODE_TYPE_META,
  type Workflow,
  type WorkflowGraph,
  type WorkflowNodeType,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowTemplate,
} from "@/lib/workflow-types";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const RUN_DOT: Record<WorkflowRunStatus, { className: string; label: string }> = {
  queued: { className: "bg-slate-400", label: "Queued" },
  running: { className: "bg-amber-500 animate-pulse", label: "Running" },
  completed: { className: "bg-emerald-500", label: "Completed" },
  failed: { className: "bg-rose-500", label: "Failed" },
  cancelled: { className: "bg-slate-400", label: "Cancelled" },
};

const EXAMPLE_PROMPTS = [
  "Every morning, search AI news and write me a brief",
  "Read a URL and turn it into a blog post",
  "Research a competitor and make a slide deck",
  "Find leads in a market and build a spreadsheet",
];

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const { data, isInitialLoading } = useApi<{ workflows: Workflow[] }>("/api/workflows");
  const workflows = data?.workflows ?? [];

  const templatesResult = useApi<{ templates: WorkflowTemplate[] }>("/api/workflows/templates");
  const templates = templatesResult.data?.templates ?? [];

  // NL builder
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  // template clone
  const [usingId, setUsingId] = useState<string | null>(null);

  // blank create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function generate() {
    const trimmed = prompt.trim();
    if (!trimmed || generating) return;
    setGenerating(true);
    setGenError(null);
    try {
      const wf = await authFetch<Workflow>("/api/workflows/generate", {
        method: "POST",
        body: JSON.stringify({ prompt: trimmed }),
      });
      void invalidateApi("/api/workflows");
      navigate(`/workflows/${wf.id}`);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Could not build that workflow. Try rephrasing.");
      setGenerating(false);
    }
  }

  async function useTemplate(tpl: WorkflowTemplate) {
    if (usingId) return;
    setUsingId(tpl.id);
    setGenError(null);
    try {
      const wf = await authFetch<Workflow>(`/api/workflows/templates/${tpl.id}/use`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      void invalidateApi("/api/workflows");
      navigate(`/workflows/${wf.id}`);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Could not use that template.");
      setUsingId(null);
    }
  }

  async function createBlank() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const wf = await authFetch<Workflow>("/api/workflows", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, enabled: false }),
      });
      void invalidateApi("/api/workflows");
      navigate(`/workflows/${wf.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create the workflow.");
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-5xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      {/* ── Hero ── */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="pt-4 text-center"
      >
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-accent to-accent2 text-white shadow-md shadow-accent/20">
          <WorkflowIcon className="size-6" />
        </div>
        <h1 className="mx-auto max-w-2xl font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          What would you like to <span className="grad-word">automate</span>?
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-sm text-muted">
          Describe a task in plain language and AI drafts the steps — searches, agents, and
          generators, chained into a workflow you can review, tweak, and run.
        </p>
      </motion.div>

      {/* ── NL builder ── */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.05, ease: "easeOut" }}
        className="mx-auto mt-7 w-full max-w-2xl"
      >
        <div className="rounded-2xl border border-line bg-surface2 p-2 shadow-sm focus-within:border-accent/50">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void generate();
              }
            }}
            placeholder="Describe what to automate and AI will build it — e.g. “Every morning, search the top AI news and write me a briefing doc.”"
            rows={3}
            maxLength={4000}
            disabled={generating}
            className="resize-none border-0 bg-transparent px-3 py-2 text-sm shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-between gap-2 px-1 pb-0.5">
            <span className="hidden pl-2 text-[11px] text-muted/70 sm:inline">
              AI generates a linear step chain (up to 6 steps)
            </span>
            <Button onClick={() => void generate()} disabled={!prompt.trim() || generating} className="ml-auto">
              {generating ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {generating ? "Building…" : "Generate"}
            </Button>
          </div>
        </div>

        {/* Example prompts */}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          {EXAMPLE_PROMPTS.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setPrompt(ex)}
              disabled={generating}
              className="rounded-full border border-line bg-surface2 px-3 py-1 text-[11px] text-muted transition hover:border-accent/40 hover:text-ink disabled:opacity-60"
            >
              {ex}
            </button>
          ))}
        </div>

        {genError && (
          <p className="mt-3 text-center text-sm text-rose-600 dark:text-rose-400">{genError}</p>
        )}
      </motion.div>

      {/* ── Template gallery ── */}
      <section className="mt-12">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">
            Start from a template
          </h2>
          {!templatesResult.isInitialLoading && (
            <span className="text-xs text-muted/70">{templates.length}</span>
          )}
        </div>

        {templatesResult.isInitialLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-2xl" />
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((tpl, i) => (
              <TemplateCard
                key={tpl.id}
                template={tpl}
                index={i}
                busy={usingId === tpl.id}
                disabled={usingId !== null}
                onUse={() => void useTemplate(tpl)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── My workflows ── */}
      <section className="mb-4 mt-12">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">
              My workflows
            </h2>
            {!isInitialLoading && workflows.length > 0 && (
              <span className="text-xs text-muted/70">{workflows.length}</span>
            )}
          </div>
          <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus />
            Blank workflow
          </Button>
        </div>

        {isInitialLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : workflows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line py-12 text-center">
            <div className="grid size-11 place-items-center rounded-2xl bg-accent/10">
              <WorkflowIcon className="size-5 text-accent" />
            </div>
            <p className="text-sm font-medium text-ink">No workflows yet</p>
            <p className="max-w-xs text-xs text-muted">
              Describe a task above, pick a template, or start from a blank canvas.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface2">
            {workflows.map((wf, i) => (
              <WorkflowRow key={wf.id} workflow={wf} index={i} />
            ))}
          </ul>
        )}
      </section>

      <Dialog open={createOpen} onOpenChange={(open) => !creating && setCreateOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Blank workflow</DialogTitle>
            <DialogDescription>Name it — you'll add the steps in the editor next.</DialogDescription>
          </DialogHeader>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void createBlank();
              }
            }}
            placeholder="e.g. Morning AI-news brief"
            maxLength={200}
            autoFocus
          />
          {createError && <p className="text-sm text-rose-600 dark:text-rose-400">{createError}</p>}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={() => void createBlank()} disabled={!name.trim() || creating}>
              {creating ? <Loader2 className="animate-spin" /> : <Plus />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── mini step-chain preview (template cards + reuse) ─────────────────────────

function StepChainPreview({ graph }: { graph: WorkflowGraph }) {
  const nodes = graph?.nodes ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1">
      {nodes.map((n, i) => {
        const meta = NODE_TYPE_META[n.type as WorkflowNodeType];
        const Icon = meta?.icon ?? WorkflowIcon;
        return (
          <div key={n.id} className="flex items-center gap-1">
            <span
              className="grid size-7 place-items-center rounded-lg bg-accent/10 text-accent"
              title={meta?.label ?? n.type}
            >
              <Icon className="size-3.5" />
            </span>
            {i < nodes.length - 1 && <ChevronRight className="size-3 text-muted/50" />}
          </div>
        );
      })}
    </div>
  );
}

// ── template card ────────────────────────────────────────────────────────────

function TemplateCard({
  template,
  index,
  busy,
  disabled,
  onUse,
}: {
  template: WorkflowTemplate;
  index: number;
  busy: boolean;
  disabled: boolean;
  onUse: () => void;
}) {
  const stepCount = template.graph?.nodes?.length ?? 0;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.04, 0.3) }}
      className="group flex flex-col rounded-2xl border border-line bg-surface2 p-4 transition hover:border-accent/40"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-full border border-line bg-surface3/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">
          {template.category}
        </span>
        <span className="text-[11px] text-muted/70">
          {stepCount} step{stepCount === 1 ? "" : "s"}
        </span>
      </div>

      <p className="mt-3 text-sm font-semibold text-ink">{template.name}</p>
      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{template.description}</p>

      <div className="mt-3">
        <StepChainPreview graph={template.graph} />
      </div>

      <Button
        variant="secondary"
        size="sm"
        onClick={onUse}
        disabled={disabled}
        className="mt-4 w-full"
      >
        {busy ? <Loader2 className="animate-spin" /> : <Wand2 />}
        {busy ? "Cloning…" : "Use template"}
      </Button>
    </motion.div>
  );
}

// ── my-workflows row ─────────────────────────────────────────────────────────

function WorkflowRow({ workflow, index }: { workflow: Workflow; index: number }) {
  const navigate = useNavigate();
  const [toggling, setToggling] = useState(false);
  const [running, setRunning] = useState(false);
  const enabled = workflow.enabled === 1;
  const dot = workflow.last_run_status ? RUN_DOT[workflow.last_run_status] : null;
  const stepCount = workflow.graph?.nodes?.length ?? 0;

  async function toggleEnabled() {
    if (toggling) return;
    setToggling(true);
    try {
      await authFetch(`/api/workflows/${workflow.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !enabled }),
      });
      await invalidateApi("/api/workflows");
    } catch {
      /* row revalidates to the truth */
    } finally {
      setToggling(false);
    }
  }

  async function runNow() {
    if (running) return;
    setRunning(true);
    try {
      const run = await authFetch<WorkflowRun>(`/api/workflows/${workflow.id}/run`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      void invalidateApi("/api/workflows");
      navigate(`/workflows/${workflow.id}/runs/${run.id}`);
    } catch {
      setRunning(false);
    }
  }

  return (
    <motion.li
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, delay: Math.min(index * 0.03, 0.24) }}
    >
      <div className="group flex items-center gap-3 px-4 py-3 transition hover:bg-ink/[0.02]">
        <Link to={`/workflows/${workflow.id}`} className="flex min-w-0 flex-1 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
            <WorkflowIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {dot && (
                <span
                  className={cn("size-2 shrink-0 rounded-full", dot.className)}
                  title={`Last run: ${dot.label}`}
                />
              )}
              <p className="truncate text-sm font-medium text-ink group-hover:text-accent">
                {workflow.name}
              </p>
            </div>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
              <span className="inline-flex items-center gap-1">
                {workflow.schedule ? (
                  <>
                    <CalendarClock className="size-3" />
                    <span className="font-mono">{workflow.schedule}</span>
                  </>
                ) : (
                  <>
                    <Hand className="size-3" />
                    Manual
                  </>
                )}
              </span>
              <span>
                {stepCount} step{stepCount === 1 ? "" : "s"}
              </span>
              {workflow.last_run_at && <span>ran {timeAgo(workflow.last_run_at)}</span>}
            </p>
          </div>
        </Link>

        {/* Enabled toggle */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={enabled ? "Disable workflow" : "Enable workflow"}
          onClick={() => void toggleEnabled()}
          disabled={toggling}
          className={cn(
            "relative h-5 w-9 shrink-0 rounded-full transition-colors",
            enabled ? "bg-accent" : "bg-ink/15",
            toggling && "opacity-60",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform",
              enabled ? "translate-x-[18px]" : "translate-x-0.5",
            )}
          />
        </button>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => void runNow()}
          disabled={running || stepCount === 0}
          title={stepCount === 0 ? "Add steps in the editor first" : "Run now"}
        >
          {running ? <Loader2 className="animate-spin" /> : <Play />}
          Run
        </Button>

        <Link to={`/workflows/${workflow.id}`} aria-label="Open editor">
          <ArrowRight className="size-4 shrink-0 text-muted/50 transition group-hover:translate-x-0.5 group-hover:text-accent" />
        </Link>
      </div>
    </motion.li>
  );
}
