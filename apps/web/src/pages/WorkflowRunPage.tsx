// /workflows/:id/runs/:runId: the live run view. GET the snapshot (flat run
// + graph + steps) to seed instantly, then live-tail the SSE stream while
// the run is active. Steps update in place on the server (running → ok /
// error / skipped), so both the replay and the tail upsert by seq; a
// refresh replays cleanly. Styled to mirror the agent StepTimeline's rail +
// card look, with artifact chips linking by kind and agent_task steps
// linking into /agent/<agent_run_id>.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { motion } from "motion/react";
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  CircleSlash,
  Clock,
  Coins,
  Hand,
  Loader2,
  ServerCrash,
  TriangleAlert,
  Wifi,
  WifiOff,
  Workflow as WorkflowIcon,
  Wrench,
} from "lucide-react";
import { authFetch } from "@/lib/use-api";
import { streamWorkflowRun, type WorkflowStreamState } from "@/lib/workflow-stream";
import {
  NODE_TYPE_META,
  isTerminalRunStatus,
  nodeConfigSummary,
  type WorkflowEvent,
  type WorkflowNode,
  type WorkflowRunDetail,
  type WorkflowRunStatus,
  type WorkflowRunStep,
  type WorkflowStepStatus,
} from "@/lib/workflow-types";
import type { ArtifactSummary } from "@/lib/types";
import { cn, formatCost, timeAgo } from "@/lib/utils";
import { ArtifactChip } from "@/components/agent/StepTimeline";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const RUN_STATUS_BADGE: Record<
  WorkflowRunStatus,
  { label: string; variant: BadgeProps["variant"]; spin?: boolean }
> = {
  queued: { label: "Queued", variant: "secondary" },
  running: { label: "Running", variant: "warning", spin: true },
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Failed", variant: "danger" },
  cancelled: { label: "Cancelled", variant: "secondary" },
};

const STEP_STATUS_BADGE: Record<
  WorkflowStepStatus,
  { label: string; variant: BadgeProps["variant"] }
> = {
  pending: { label: "Pending", variant: "secondary" },
  running: { label: "Running", variant: "warning" },
  ok: { label: "Done", variant: "success" },
  error: { label: "Error", variant: "danger" },
  skipped: { label: "Skipped", variant: "secondary" },
};

function fmtDuration(startIso: string | null, endIso: string | null): string | null {
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const secs = Math.round((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export default function WorkflowRunPage() {
  const { id: workflowId, runId } = useParams<{ id: string; runId: string }>();

  const [run, setRun] = useState<WorkflowRunDetail | null>(null);
  const [steps, setSteps] = useState<WorkflowRunStep[]>([]);
  const [progress, setProgress] = useState<Record<number, string>>({});
  const [connection, setConnection] = useState<WorkflowStreamState>("connecting");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const stepsMapRef = useRef<Map<number, WorkflowRunStep>>(new Map());
  const nodeByIdRef = useRef<Map<string, WorkflowNode>>(new Map());

  const flushSteps = useCallback(() => {
    setSteps([...stepsMapRef.current.values()].sort((a, b) => a.seq - b.seq));
  }, []);

  const handleEvent = useCallback(
    (evt: WorkflowEvent) => {
      switch (evt.type) {
        case "wf_step":
          stepsMapRef.current.set(evt.step.seq, evt.step);
          if (evt.step.status !== "running") {
            setProgress((p) => {
              if (!(evt.step.seq in p)) return p;
              const next = { ...p };
              delete next[evt.step.seq];
              return next;
            });
          }
          flushSteps();
          break;
        case "wf_step_progress":
          setProgress((p) => ({ ...p, [evt.seq]: evt.label }));
          break;
        case "wf_run_status":
          setRun((prev) =>
            prev
              ? { ...prev, status: evt.status, cost_usd: evt.cost_usd, error: evt.error }
              : prev,
          );
          break;
        case "close":
          break;
      }
    },
    [flushSteps],
  );

  // ── mount: snapshot seed + live tail (StrictMode-guarded) ──
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let stream: ReturnType<typeof streamWorkflowRun> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setLoadError(null);
    stepsMapRef.current = new Map();
    (async () => {
      try {
        const snap = await authFetch<WorkflowRunDetail>(`/api/workflows/runs/${runId}`);
        if (cancelled) return;
        nodeByIdRef.current = new Map((snap.graph?.nodes ?? []).map((n) => [n.id, n]));
        for (const s of snap.steps ?? []) stepsMapRef.current.set(s.seq, s);
        flushSteps();
        setRun(snap);
        setLoading(false);
        if (!isTerminalRunStatus(snap.status)) {
          stream = streamWorkflowRun({
            runId,
            onEvent: handleEvent,
            onConnectionChange: setConnection,
          });
          stream.start();
          // Safety net: the SSE can miss the terminal event if the run finishes
          // between the snapshot fetch and the subscription, or never attaches
          // (e.g. the API was restarted). Poll the snapshot until the run is
          // terminal, then reconcile status/steps and stop streaming — so a
          // finished run never sits on "Running / Connecting…" indefinitely.
          const poll = async () => {
            if (cancelled) return;
            try {
              const latest = await authFetch<WorkflowRunDetail>(`/api/workflows/runs/${runId}`);
              if (cancelled) return;
              for (const s of latest.steps ?? []) stepsMapRef.current.set(s.seq, s);
              flushSteps();
              setRun((prev) =>
                prev
                  ? {
                      ...prev,
                      status: latest.status,
                      cost_usd: latest.cost_usd,
                      error: latest.error,
                      finished_at: latest.finished_at,
                    }
                  : latest,
              );
              if (isTerminalRunStatus(latest.status)) {
                stream?.stop();
                return;
              }
            } catch {
              /* transient — keep polling */
            }
            pollTimer = setTimeout(poll, 4000);
          };
          pollTimer = setTimeout(poll, 4000);
        } else {
          setConnection("closed");
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Could not load this run.");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      stream?.stop();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [runId, handleEvent, flushSteps]);

  const active = run != null && !isTerminalRunStatus(run.status);

  return (
    <div className="h-screen overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-3xl px-5 py-6 md:px-8">
        <div className="mb-4 pl-10 lg:pl-0">
          <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted">
            <Link to={workflowId ? `/workflows/${workflowId}` : "/workflows"}>
              <ArrowLeft />
              {run?.workflow_name ?? "Workflow"}
            </Link>
          </Button>
        </div>

        {loadError ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface2 px-6 py-14 text-center">
            <ServerCrash className="size-8 text-rose-500" />
            <p className="font-display text-lg font-semibold text-ink">Couldn't load this run</p>
            <p className="max-w-sm text-sm text-muted">{loadError}</p>
            <Button variant="secondary" asChild>
              <Link to="/workflows">Back to workflows</Link>
            </Button>
          </div>
        ) : loading || !run ? (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-28 w-full rounded-2xl" />
            <div className="space-y-3 pl-9">
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-16 w-4/5 rounded-xl" />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <RunHeaderPanel run={run} connection={active ? connection : undefined} />

            {run.status === "failed" && run.error && (
              <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3.5 py-2.5 text-[13px] text-rose-600 dark:text-rose-400">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{run.error}</span>
              </div>
            )}

            <StepList steps={steps} nodeById={nodeByIdRef.current} progress={progress} />

            {steps.length === 0 && (
              <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted">
                <Loader2 className="size-4 animate-spin text-accent" />
                Waiting for the first step…
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── header ───────────────────────────────────────────────────────────────────

function RunHeaderPanel({
  run,
  connection,
}: {
  run: WorkflowRunDetail;
  connection?: WorkflowStreamState;
}) {
  const meta = RUN_STATUS_BADGE[run.status] ?? RUN_STATUS_BADGE.queued;
  const duration = fmtDuration(run.started_at, run.finished_at);
  return (
    <div className="rounded-2xl border border-line bg-surface2 p-4 md:p-5">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <Badge variant={meta.variant}>
          {meta.spin && <Loader2 className="size-3 animate-spin" />}
          {meta.label}
        </Badge>
        <Badge variant="outline">
          {run.trigger === "cron" ? <Clock className="size-3" /> : <Hand className="size-3" />}
          <span className="capitalize">{run.trigger}</span>
        </Badge>
        {connection === "reconnecting" && (
          <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
            <WifiOff className="size-3" /> Reconnecting…
          </span>
        )}
        {connection === "connecting" && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted">
            <Wifi className="size-3" /> Connecting…
          </span>
        )}
      </div>
      <h1 className="flex items-center gap-2 font-display text-lg font-semibold leading-tight tracking-tight text-ink md:text-xl">
        <WorkflowIcon className="size-5 text-accent" />
        {run.workflow_name ?? "Workflow run"}
      </h1>
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-muted">
        <span>Started {run.started_at ? timeAgo(run.started_at) : timeAgo(run.created_at)}</span>
        {duration && <span className="tabular-nums">{duration}</span>}
        {run.cost_usd > 0 && (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Coins className="size-3.5" />
            {formatCost(run.cost_usd)}
          </span>
        )}
      </div>
    </div>
  );
}

// ── step list (mirrors the agent timeline's rail + card look) ───────────────

function StepList({
  steps,
  nodeById,
  progress,
}: {
  steps: WorkflowRunStep[];
  nodeById: Map<string, WorkflowNode>;
  progress: Record<number, string>;
}) {
  if (steps.length === 0) return null;
  return (
    <div className="relative">
      <span aria-hidden className="absolute left-3 top-2 bottom-2 w-px bg-line" />
      <div className="flex flex-col gap-3">
        {steps.map((step) => (
          <StepRow
            key={step.seq}
            step={step}
            node={nodeById.get(step.node_id) ?? null}
            progressLabel={progress[step.seq]}
          />
        ))}
      </div>
    </div>
  );
}

function StepRow({
  step,
  node,
  progressLabel,
}: {
  step: WorkflowRunStep;
  node: WorkflowNode | null;
  progressLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const meta = NODE_TYPE_META[step.node_type as keyof typeof NODE_TYPE_META];
  const Icon = meta?.icon ?? Wrench;
  const running = step.status === "running";
  const isError = step.status === "error";
  const badge = STEP_STATUS_BADGE[step.status] ?? STEP_STATUS_BADGE.pending;
  const summary = node ? nodeConfigSummary(node.type, node.config) : step.node_id;
  const duration = fmtDuration(step.started_at, step.finished_at);
  const detail = isError ? step.error ?? "" : step.output?.text ?? "";

  const artifact: ArtifactSummary | null = step.output?.artifact_id
    ? {
        id: step.output.artifact_id,
        kind: step.output.kind ?? "doc",
        title: step.output.title ?? "Generated artifact",
        rel_path: null,
        parent_id: null,
        hub_id: null,
        meta: null,
        created_at: step.created_at,
      }
    : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="relative pl-9"
    >
      <span
        className={cn(
          "absolute left-0 top-0.5 grid size-6 place-items-center rounded-full border bg-surface",
          running ? "border-accent/60 ring-2 ring-accent/15" : "border-line",
        )}
      >
        {step.status === "skipped" ? (
          <CircleSlash className="size-3.5 text-muted" />
        ) : (
          <Icon className={cn("size-3.5", running ? "text-accent" : "text-muted")} />
        )}
      </span>

      <div
        className={cn(
          "rounded-xl border bg-surface2 transition-colors",
          isError ? "border-rose-500/30" : "border-line",
        )}
      >
        <div className="flex items-start gap-2 px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-ink" title={summary}>
              <span className="text-muted">{step.seq}.</span> {meta?.label ?? step.node_type}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted" title={summary}>
              {running && progressLabel ? progressLabel : summary}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {duration && <span className="text-[11px] tabular-nums text-muted">{duration}</span>}
            <Badge variant={badge.variant}>
              {running && <Loader2 className="size-3 animate-spin" />}
              {badge.label}
            </Badge>
          </div>
        </div>

        {(artifact || step.output?.agent_run_id || step.status === "skipped") && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line/70 px-3.5 py-2">
            {artifact && <ArtifactChip artifact={artifact} />}
            {step.output?.agent_run_id && (
              <Link
                to={`/agent/${step.output.agent_run_id}`}
                className="group inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-muted transition hover:border-accent/40 hover:text-accent"
              >
                <Bot className="size-3.5" />
                View agent run
                <ChevronRight className="size-3 transition group-hover:translate-x-0.5" />
              </Link>
            )}
            {step.status === "skipped" && (
              <span className="text-[11px] text-muted">{step.error ?? "Skipped."}</span>
            )}
          </div>
        )}

        {detail.trim() && (
          <div className="border-t border-line/70">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 px-3.5 py-1.5 text-left text-[11px] font-medium text-muted transition hover:text-ink"
              aria-expanded={open}
            >
              <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
              {open ? "Hide output" : "Show output"}
            </button>
            {open && (
              <pre
                className={cn(
                  "max-h-72 overflow-auto scrollbar-thin whitespace-pre-wrap break-words px-3.5 pb-3 text-[12px] leading-relaxed",
                  isError ? "text-rose-600 dark:text-rose-400" : "text-ink/80",
                )}
              >
                {detail}
              </pre>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
