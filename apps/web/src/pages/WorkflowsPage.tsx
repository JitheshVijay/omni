// /workflows — automation chains list. Each row: name, schedule chip,
// enabled toggle (PATCH), last-run status dot, and a Run-now button that
// jumps straight into the live run view. Creating a workflow only asks for
// a name, then hands off to the editor.

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  ArrowRight,
  CalendarClock,
  Hand,
  Loader2,
  Play,
  Plus,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { authFetch, invalidateApi, useApi } from "@/lib/use-api";
import type { Workflow, WorkflowRun, WorkflowRunStatus } from "@/lib/workflow-types";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const { data, isInitialLoading } = useApi<{ workflows: Workflow[] }>("/api/workflows");
  const workflows = data?.workflows ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const wf = await authFetch<Workflow>("/api/workflows", {
        method: "POST",
        body: JSON.stringify({ name: trimmed }),
      });
      void invalidateApi("/api/workflows");
      navigate(`/workflows/${wf.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the workflow.");
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-4xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="flex flex-wrap items-center gap-3 pl-10 lg:pl-0"
      >
        <div className="grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-accent to-accent2 shadow-lg shadow-accent/25">
          <WorkflowIcon className="size-6 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Workflows</h1>
          <p className="text-sm text-muted">
            Chain searches, agents, and generators — run them by hand or on a schedule.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus />
          New workflow
        </Button>
      </motion.div>

      <div className="mt-8">
        {isInitialLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : workflows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line py-14 text-center">
            <div className="grid size-11 place-items-center rounded-2xl bg-accent/10">
              <WorkflowIcon className="size-5 text-accent" />
            </div>
            <p className="text-sm font-medium text-ink">No workflows yet</p>
            <p className="max-w-xs text-xs text-muted">
              Build a chain like “search → agent brief → doc” and schedule it to run every
              morning.
            </p>
            <Button variant="secondary" size="sm" className="mt-2" onClick={() => setCreateOpen(true)}>
              <Plus />
              Create your first workflow
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface2">
            {workflows.map((wf, i) => (
              <WorkflowRow key={wf.id} workflow={wf} index={i} />
            ))}
          </ul>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={(open) => !creating && setCreateOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New workflow</DialogTitle>
            <DialogDescription>Name it — you'll add the steps in the editor next.</DialogDescription>
          </DialogHeader>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              }
            }}
            placeholder="e.g. Morning AI-news brief"
            maxLength={200}
            autoFocus
          />
          {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={!name.trim() || creating}>
              {creating ? <Loader2 className="animate-spin" /> : <Plus />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

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
        <Link
          to={`/workflows/${workflow.id}`}
          className="flex min-w-0 flex-1 items-center gap-3"
        >
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
