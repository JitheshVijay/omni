// The run's vertical timeline. Persisted steps (seeded from the snapshot and
// appended from live SSE) normalise to AgentStep[]; here they become rows:
//   • tool_call  → one row, resolved IN PLACE by its tool_result (paired by
//                  order + tool name, since v1 runs tools sequentially)
//   • assistant_message → a markdown block (reuses MarkdownMessage)
//   • artifact_created  → a chip linking to the right viewer by kind
//   • compaction / budget_warning / run_* / confirmation_resolved → subtle
//                  system rows
// plan_updated (PlanChecklist), confirmation_required (the inline card) and
// run_completed (the final report panel) are rendered by the page, not here.

import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import {
  AudioLines,
  Bot,
  Captions,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  Code,
  Database,
  FileText,
  Globe,
  HardDrive,
  Image as ImageIcon,
  Layers,
  ListChecks,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  Presentation,
  Scissors,
  Search,
  TriangleAlert,
  Wand2,
  Wrench,
  XCircle,
} from "lucide-react";
import type { AgentStep, StepStatus } from "@/lib/agent-types";
import type { ArtifactSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { MarkdownMessage } from "@/components/MarkdownMessage";

// ── helpers ─────────────────────────────────────────────────────────────────

function fmtDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function tryJson(s: string | null | undefined): unknown {
  if (!s || typeof s !== "string") return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Best-effort recover an ArtifactSummary from a step. Live artifact_created
// events carry it directly; snapshot rows stash it in content or tool_args.
export function artifactFromStep(step: AgentStep): ArtifactSummary | null {
  if (step.artifact) return step.artifact;
  const candidates: unknown[] = [step.tool_args, tryJson(step.content)];
  for (const c of candidates) {
    if (c && typeof c === "object") {
      const obj = c as Record<string, unknown>;
      if (typeof obj.id === "string" && typeof obj.kind === "string") {
        return obj as unknown as ArtifactSummary;
      }
      const nested = obj.artifact as Record<string, unknown> | undefined;
      if (nested && typeof nested.id === "string" && typeof nested.kind === "string") {
        return nested as unknown as ArtifactSummary;
      }
    }
  }
  return null;
}

const TOOL_ICONS: Record<string, typeof Wrench> = {
  web_search: Search,
  search: Search,
  fetch_url: Globe,
  read_url: Globe,
  youtube_transcript: Captions,
  drive_list: HardDrive,
  drive_read: HardDrive,
  drive_write: HardDrive,
  hub_memory_search: Database,
  generate_image: ImageIcon,
  create_image: ImageIcon,
  run_code: Code,
  create_document: FileText,
  create_doc: FileText,
  create_slides: Presentation,
  create_deck: Presentation,
  create_audio: AudioLines,
  create_tts: AudioLines,
  ask_user: MessageSquare,
  update_plan: ListChecks,
};

function toolIcon(name: string | null | undefined): typeof Wrench {
  if (!name) return Wrench;
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (name.startsWith("create_") || name.startsWith("revise_")) return Wand2;
  return Wrench;
}

const KIND_ICON: Record<string, typeof FileText> = {
  doc: FileText,
  image: ImageIcon,
  slides: Presentation,
  audio: AudioLines,
  sheet: Layers,
  webpage: Globe,
};

const STATUS_BADGE: Record<StepStatus, { label: string; variant: BadgeProps["variant"] }> = {
  running: { label: "Running", variant: "warning" },
  ok: { label: "Done", variant: "success" },
  error: { label: "Error", variant: "danger" },
  skipped: { label: "Skipped", variant: "secondary" },
};

// ── row model ───────────────────────────────────────────────────────────────

interface ToolRow {
  kind: "tool";
  key: string;
  call: AgentStep | null;
  result: AgentStep | null;
}
interface SimpleRow {
  kind: "assistant" | "artifact" | "system";
  key: string;
  step: AgentStep;
}
type Row = ToolRow | SimpleRow;

const SKIP_KINDS = new Set(["plan_updated", "confirmation_required", "run_completed"]);

function buildRows(steps: AgentStep[]): Row[] {
  const sorted = [...steps].sort((a, b) => a.seq - b.seq);
  const rows: Row[] = [];
  const unresolved: ToolRow[] = [];

  for (const step of sorted) {
    if (SKIP_KINDS.has(step.kind)) continue;
    switch (step.kind) {
      case "tool_call": {
        const row: ToolRow = { kind: "tool", key: `t${step.seq}`, call: step, result: null };
        rows.push(row);
        unresolved.push(row);
        break;
      }
      case "tool_result": {
        let idx = unresolved.findIndex((r) => r.call?.tool_name === step.tool_name);
        if (idx === -1) idx = unresolved.length ? 0 : -1;
        if (idx >= 0) {
          const [row] = unresolved.splice(idx, 1);
          row.result = step;
        } else {
          rows.push({ kind: "tool", key: `tr${step.seq}`, call: null, result: step });
        }
        break;
      }
      case "assistant_message":
        if ((step.content ?? "").trim()) {
          rows.push({ kind: "assistant", key: `a${step.seq}`, step });
        }
        break;
      case "artifact_created":
        rows.push({ kind: "artifact", key: `art${step.seq}`, step });
        break;
      default:
        rows.push({ kind: "system", key: `s${step.seq}`, step });
    }
  }
  return rows;
}

// ── component ───────────────────────────────────────────────────────────────

export function StepTimeline({
  steps,
  streamingText,
  className,
}: {
  steps: AgentStep[];
  streamingText?: string | null;
  className?: string;
}) {
  const rows = buildRows(steps);
  const hasStreaming = !!streamingText && streamingText.trim().length > 0;

  if (rows.length === 0 && !hasStreaming) {
    return (
      <div className={cn("flex items-center gap-2 px-1 py-6 text-sm text-muted", className)}>
        <Loader2 className="size-4 animate-spin text-accent" />
        Waiting for the agent to begin…
      </div>
    );
  }

  return (
    <div className={cn("relative", className)}>
      {/* Continuous rail behind the nodes. */}
      <span
        aria-hidden
        className="absolute left-3 top-2 bottom-2 w-px bg-line"
      />
      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <TimelineRowShell key={row.key} row={row}>
            {row.kind === "tool" && <ToolRowItem row={row} />}
            {row.kind === "assistant" && <AssistantRow step={row.step} />}
            {row.kind === "artifact" && <ArtifactRow step={row.step} />}
            {row.kind === "system" && <SystemRow step={row.step} />}
          </TimelineRowShell>
        ))}

        {hasStreaming && (
          <TimelineRowShell
            row={{ kind: "assistant", key: "streaming", step: {} as AgentStep }}
            node={<Bot className="size-3.5 text-accent" />}
            pulse
          >
            <div className="rounded-xl border border-line bg-surface2 px-3.5 py-2.5">
              <MarkdownMessage content={streamingText ?? ""} />
              <span className="mt-1 inline-block h-3.5 w-[2px] animate-pulse bg-accent align-middle" />
            </div>
          </TimelineRowShell>
        )}
      </div>
    </div>
  );
}

// Left rail node + right content column.
function TimelineRowShell({
  row,
  children,
  node,
  pulse,
}: {
  row: Row;
  children: React.ReactNode;
  node?: React.ReactNode;
  pulse?: boolean;
}) {
  const resolvedNode = node ?? defaultNode(row);
  const running =
    pulse || (row.kind === "tool" && !!row.call && !row.result);
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
        {resolvedNode}
      </span>
      {children}
    </motion.div>
  );
}

function defaultNode(row: Row): React.ReactNode {
  switch (row.kind) {
    case "assistant":
      return <Bot className="size-3.5 text-muted" />;
    case "artifact": {
      const art = artifactFromStep(row.step);
      const Icon = (art && KIND_ICON[art.kind]) || FileText;
      return <Icon className="size-3.5 text-accent" />;
    }
    case "system":
      return <SystemNodeIcon step={row.step} />;
    case "tool": {
      if (row.call?.tool_name || row.result?.tool_name) {
        const Icon = toolIcon(row.call?.tool_name ?? row.result?.tool_name);
        const running = !!row.call && !row.result;
        return (
          <Icon className={cn("size-3.5", running ? "text-accent" : "text-muted")} />
        );
      }
      return <Wrench className="size-3.5 text-muted" />;
    }
  }
}

// ── tool row ────────────────────────────────────────────────────────────────

function ToolRowItem({ row }: { row: ToolRow }) {
  const [open, setOpen] = useState(false);
  const call = row.call;
  const result = row.result;
  const running = !!call && !result;

  const label =
    call?.label ||
    call?.summary ||
    result?.summary ||
    `${call?.tool_name ?? result?.tool_name ?? "tool"}`;

  const argsPreview =
    call?.args_preview ??
    (call?.tool_args ? compactArgs(call.tool_args) : null);

  const status: StepStatus = running ? "running" : (result?.status ?? call?.status ?? "ok");
  const badge = STATUS_BADGE[status] ?? STATUS_BADGE.ok;
  const duration = fmtDuration(result?.duration_ms);
  const preview = (result?.content ?? "").trim();
  const isError = status === "error";

  return (
    <div
      className={cn(
        "rounded-xl border bg-surface2 shadow-sm transition-colors",
        isError ? "border-rose-500/30" : "border-line",
      )}
    >
      <div className="flex items-start gap-2 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink" title={label}>
            {label}
          </p>
          {argsPreview && (
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted" title={argsPreview}>
              {argsPreview}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {duration && (
            <span className="text-[11px] tabular-nums text-muted">{duration}</span>
          )}
          <Badge variant={badge.variant}>
            {running && <Loader2 className="size-3 animate-spin" />}
            {badge.label}
          </Badge>
        </div>
      </div>

      {preview && (
        <div className="border-t border-line/70">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 px-3.5 py-1.5 text-left text-[11px] font-medium text-muted transition hover:text-ink"
            aria-expanded={open}
          >
            <ChevronRight
              className={cn("size-3 transition-transform", open && "rotate-90")}
            />
            {open ? "Hide output" : "Show output"}
            {result?.full_available && (
              <span className="ml-auto text-[10px] font-normal text-muted/70">
                full output stored on server
              </span>
            )}
          </button>
          {open && (
            <pre
              className={cn(
                "max-h-72 overflow-auto scrollbar-thin whitespace-pre-wrap break-words px-3.5 pb-3 text-[12px] leading-relaxed",
                isError ? "text-rose-600 dark:text-rose-400" : "text-ink/80",
              )}
            >
              {preview}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function compactArgs(args: Record<string, unknown>): string | null {
  try {
    const entries = Object.entries(args);
    if (entries.length === 0) return null;
    return entries
      .map(([k, v]) => {
        let val = typeof v === "string" ? v : JSON.stringify(v);
        if (val && val.length > 80) val = `${val.slice(0, 80)}…`;
        return `${k}: ${val}`;
      })
      .join("  ·  ");
  } catch {
    return null;
  }
}

// ── assistant row ───────────────────────────────────────────────────────────

function AssistantRow({ step }: { step: AgentStep }) {
  return (
    <div className="rounded-xl border border-line bg-surface2 px-3.5 py-2.5">
      <MarkdownMessage content={step.content ?? ""} />
    </div>
  );
}

// ── artifact row ────────────────────────────────────────────────────────────

function artifactHref(a: ArtifactSummary): { to: string; state?: unknown } {
  switch (a.kind) {
    case "doc":
      return { to: `/tools/docs/${a.id}` };
    case "image":
      return { to: "/tools/images", state: { openId: a.id } };
    case "slides":
      return { to: `/tools/slides/${a.id}` };
    default:
      return { to: "/library" };
  }
}

export function ArtifactChip({ artifact }: { artifact: ArtifactSummary }) {
  const Icon = KIND_ICON[artifact.kind] ?? FileText;
  const { to, state } = artifactHref(artifact);
  return (
    <Link
      to={to}
      state={state}
      className="group inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm shadow-sm transition hover:border-accent/40 hover:shadow-md"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent/10 text-accent">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium text-ink group-hover:text-accent">
          {artifact.title || `Untitled ${artifact.kind}`}
        </span>
        <span className="block text-[11px] capitalize text-muted">{artifact.kind}</span>
      </span>
      <ChevronRight className="ml-1 size-4 shrink-0 text-muted/50 transition group-hover:translate-x-0.5 group-hover:text-accent" />
    </Link>
  );
}

function ArtifactRow({ step }: { step: AgentStep }) {
  const art = artifactFromStep(step);
  if (!art) {
    return (
      <div className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted">
        <FileText className="size-4" />
        {step.summary || "Artifact created"}
      </div>
    );
  }
  return <ArtifactChip artifact={art} />;
}

// ── system rows ─────────────────────────────────────────────────────────────

function SystemNodeIcon({ step }: { step: AgentStep }) {
  switch (step.kind) {
    case "compaction":
      return <Scissors className="size-3 text-muted" />;
    case "budget_warning":
      return <TriangleAlert className="size-3 text-amber-500" />;
    case "run_paused":
      return <Pause className="size-3 text-muted" />;
    case "run_resumed":
      return <Play className="size-3 text-muted" />;
    case "run_failed":
      return <XCircle className="size-3 text-rose-500" />;
    case "run_cancelled":
      return <CircleSlash className="size-3 text-muted" />;
    case "confirmation_resolved":
      return <CircleCheck className="size-3 text-muted" />;
    default:
      return <Bot className="size-3 text-muted" />;
  }
}

function systemText(step: AgentStep): string {
  switch (step.kind) {
    case "compaction": {
      const n = numberFrom(step, "folded_steps") ?? numberFromContent(step);
      return step.summary || (n ? `Folded ${n} earlier steps to stay within context.` : "Compacted context.");
    }
    case "budget_warning":
      return step.summary || step.content || "Approaching the budget cap.";
    case "run_paused":
      return "Run paused.";
    case "run_resumed":
      return "Run resumed.";
    case "run_started":
      return "Run started.";
    case "run_failed":
      return step.summary || step.content || "Run failed.";
    case "run_cancelled":
      return step.summary || "Run cancelled.";
    case "confirmation_resolved":
      return step.summary || resolvedText(step);
    default:
      return step.summary || step.content || step.kind.replace(/_/g, " ");
  }
}

function resolvedText(step: AgentStep): string {
  const args = step.tool_args as Record<string, unknown> | null | undefined;
  const action = typeof args?.action === "string" ? args.action : null;
  const tool = step.tool_name;
  if (action === "skip") return tool ? `Skipped ${tool}.` : "Skipped.";
  if (action === "confirm") return tool ? `Confirmed ${tool}.` : "Confirmed.";
  return "Confirmation resolved.";
}

function numberFrom(step: AgentStep, key: string): number | null {
  const args = step.tool_args as Record<string, unknown> | null | undefined;
  const v = args?.[key];
  return typeof v === "number" ? v : null;
}
function numberFromContent(step: AgentStep): number | null {
  const n = Number(step.content);
  return Number.isFinite(n) ? n : null;
}

function SystemRow({ step }: { step: AgentStep }) {
  const isWarn = step.kind === "budget_warning" || step.kind === "run_failed";
  return (
    <div
      className={cn(
        "py-0.5 text-[12px]",
        isWarn ? "text-amber-600 dark:text-amber-400" : "text-muted",
      )}
    >
      {systemText(step)}
    </div>
  );
}
