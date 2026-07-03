// The run's header: status badge, live cost-vs-budget meter, iteration count,
// and the lifecycle controls (Cancel while active, Pause/Resume, and Resume
// for a failed+resumable run). Control handlers are async and owned by the
// page; this component just disables the row while one is in flight.

import { useState } from "react";
import {
  Ban,
  Clock,
  CircleCheck,
  CircleSlash,
  Gauge,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  ShieldQuestion,
  Wifi,
  WifiOff,
  XCircle,
} from "lucide-react";
import type { AgentRun, AgentRunStatus } from "@/lib/agent-types";
import { isTerminalStatus } from "@/lib/agent-types";
import type { AgentStreamState } from "@/lib/agent-stream";
import { cn, formatCost } from "@/lib/utils";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// ── shared status badge (also used by the launcher's run list) ──────────────

const STATUS_META: Record<
  AgentRunStatus,
  { label: string; variant: BadgeProps["variant"]; icon: typeof Clock; spin?: boolean }
> = {
  queued: { label: "Queued", variant: "secondary", icon: Clock },
  planning: { label: "Planning", variant: "warning", icon: Loader2, spin: true },
  running: { label: "Running", variant: "warning", icon: Loader2, spin: true },
  awaiting_confirmation: {
    label: "Needs you",
    variant: "warning",
    icon: ShieldQuestion,
  },
  paused: { label: "Paused", variant: "secondary", icon: Pause },
  completed: { label: "Completed", variant: "success", icon: CircleCheck },
  failed: { label: "Failed", variant: "danger", icon: XCircle },
  cancelled: { label: "Cancelled", variant: "secondary", icon: CircleSlash },
};

export function RunStatusBadge({
  status,
  className,
}: {
  status: AgentRunStatus;
  className?: string;
}) {
  const meta = STATUS_META[status] ?? STATUS_META.queued;
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className={className}>
      <Icon className={cn("size-3", meta.spin && "animate-spin")} />
      {meta.label}
    </Badge>
  );
}

// ── header ──────────────────────────────────────────────────────────────────

type PendingAction = "cancel" | "pause" | "resume" | null;

export interface RunHeaderProps {
  run: AgentRun;
  connection?: AgentStreamState;
  onCancel: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
}

export function RunHeader({ run, connection, onCancel, onPause, onResume }: RunHeaderProps) {
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(kind: Exclude<PendingAction, null>, fn: () => Promise<void>) {
    if (pending) return;
    setPending(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setPending(null);
    }
  }

  const terminal = isTerminalStatus(run.status);
  const resumable = run.resumable === true || run.resumable === 1;
  const canCancel = !terminal;
  const canPause =
    run.status === "queued" || run.status === "planning" || run.status === "running";
  const canResume = run.status === "paused" || (run.status === "failed" && resumable);

  const budget = run.budget_usd || 0;
  const cost = run.cost_usd || 0;
  const pct = budget > 0 ? Math.min(cost / budget, 1) * 100 : 0;
  const overBudget = budget > 0 && cost >= budget;
  const nearBudget = budget > 0 && cost >= budget * 0.8;
  const meterColor = overBudget
    ? "bg-rose-500"
    : nearBudget
      ? "bg-amber-500"
      : "bg-accent";

  return (
    <div className="rounded-2xl border border-line bg-surface2 p-4 shadow-sm md:p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} />
            {connection === "reconnecting" && (
              <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                <WifiOff className="size-3" /> Reconnecting…
              </span>
            )}
            {connection === "connecting" && !terminal && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted">
                <Wifi className="size-3" /> Connecting…
              </span>
            )}
          </div>
          <h1 className="font-display text-lg font-semibold leading-tight tracking-tight text-ink md:text-xl">
            {run.title || run.goal}
          </h1>
          {run.title && run.goal && run.title !== run.goal && (
            <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-muted">
              {run.goal}
            </p>
          )}
        </div>

        {/* Controls */}
        <div className="flex shrink-0 items-center gap-2">
          {canPause && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void act("pause", onPause)}
              disabled={pending !== null}
            >
              {pending === "pause" ? <Loader2 className="animate-spin" /> : <Pause />}
              Pause
            </Button>
          )}
          {canResume && (
            <Button
              size="sm"
              onClick={() => void act("resume", onResume)}
              disabled={pending !== null}
            >
              {pending === "resume" ? (
                <Loader2 className="animate-spin" />
              ) : run.status === "paused" ? (
                <Play />
              ) : (
                <RotateCcw />
              )}
              Resume
            </Button>
          )}
          {canCancel && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void act("cancel", onCancel)}
              disabled={pending !== null}
              className="text-muted hover:text-rose-600 dark:hover:text-rose-400"
            >
              {pending === "cancel" ? <Loader2 className="animate-spin" /> : <Ban />}
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Meters */}
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="min-w-[180px] flex-1">
          <div className="mb-1 flex items-center justify-between text-[11px]">
            <span className="inline-flex items-center gap-1 font-medium text-muted">
              <Gauge className="size-3" /> Budget
            </span>
            <span
              className={cn(
                "tabular-nums",
                overBudget
                  ? "text-rose-600 dark:text-rose-400"
                  : nearBudget
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted",
              )}
            >
              {formatCost(cost)}
              {budget > 0 && <span className="text-muted"> / {formatCost(budget)}</span>}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink/10">
            <div
              className={cn("h-full rounded-full transition-all duration-500", meterColor)}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        <Stat label="Iteration" value={`${run.iter_count}/${run.max_iterations}`} />
        {run.model && <Stat label="Model" value={run.model.split("/").pop() ?? run.model} />}
      </div>

      {error && (
        <p className="mt-3 text-[12px] text-rose-600 dark:text-rose-400">{error}</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] font-medium text-muted">{label}</span>
      <span className="text-[13px] font-medium tabular-nums text-ink">{value}</span>
    </div>
  );
}
