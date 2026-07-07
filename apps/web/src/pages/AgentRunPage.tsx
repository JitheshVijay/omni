// /agent/:id — the live run view.
//
// On mount we GET the run snapshot (flat run + steps + plan + any pending
// confirmation) to seed the UI instantly, THEN open the SSE stream from
// after=<max seq seen> to live-tail. Steps are keyed by seq in a ref map, so
// the snapshot seed and the live tail dedupe cleanly and a refresh replays
// without duplication. The initial subscribe is guarded against StrictMode's
// double mount with the cancellable pattern (cancelled flag + stream.stop()).
//
// Lifecycle controls (cancel/pause/resume) and card confirmation POST and then
// resync: they stop the stream, re-fetch the snapshot, and reopen from the new
// high-water seq — which is how a failed→Resume run (whose stream had stopped)
// picks the timeline back up.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Bot, ServerCrash, Sparkles, TriangleAlert, Volume2 } from "lucide-react";
import { authFetch } from "@/lib/use-api";
import {
  cancelRun,
  confirmCard,
  pauseRun,
  resumeRun,
  streamAgentRun,
  type AgentRunStream,
  type AgentStreamState,
} from "@/lib/agent-stream";
import type {
  AgentEvent,
  AgentRun,
  AgentRunDetail,
  AgentStep,
  ConfirmAction,
  ConfirmationCard as CardData,
  PlanItem,
} from "@/lib/agent-types";
import { isActiveStatus } from "@/lib/agent-types";
import type { ArtifactSummary } from "@/lib/types";
import { useReadAloud, MiniPlayer, VOICE_UNCONFIGURED_HINT } from "@/lib/audio-player";
import { RunHeader } from "@/components/agent/RunHeader";
import { PlanChecklist } from "@/components/agent/PlanChecklist";
import {
  StepTimeline,
  ArtifactChip,
  artifactFromStep,
} from "@/components/agent/StepTimeline";
import { ConfirmationCard } from "@/components/agent/ConfirmationCard";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// Normalise a persisted SSE event into a timeline step. Non-persisted events
// (delta/close/run_status/plan_updated) return null — they're handled directly.
function stepFromEvent(evt: AgentEvent): AgentStep | null {
  switch (evt.type) {
    case "assistant_message":
      return {
        seq: evt.seq,
        iter: 0,
        kind: "assistant_message",
        tool_name: null,
        status: null,
        content: evt.text,
        summary: null,
        duration_ms: null,
      };
    case "tool_call":
      return {
        seq: evt.seq,
        iter: evt.iter,
        kind: "tool_call",
        tool_name: evt.tool,
        status: "running",
        content: null,
        summary: evt.label,
        label: evt.label,
        args_preview: evt.args_preview,
        duration_ms: null,
      };
    case "tool_result":
      return {
        seq: evt.seq,
        iter: 0,
        kind: "tool_result",
        tool_name: evt.tool,
        status: evt.status,
        content: evt.preview,
        summary: null,
        duration_ms: evt.duration_ms,
        full_available: evt.full_available,
      };
    case "artifact_created":
      return {
        seq: evt.seq,
        iter: 0,
        kind: "artifact_created",
        tool_name: null,
        status: null,
        content: null,
        summary: null,
        duration_ms: null,
        artifact: evt.artifact,
      };
    case "confirmation_resolved":
      return {
        seq: evt.seq,
        iter: 0,
        kind: "confirmation_resolved",
        tool_name: null,
        status: null,
        content: null,
        summary: null,
        duration_ms: null,
        tool_args: { action: evt.action, card_id: evt.card_id },
      };
    case "compaction":
      return {
        seq: evt.seq,
        iter: 0,
        kind: "compaction",
        tool_name: null,
        status: null,
        content: String(evt.folded_steps),
        summary: null,
        duration_ms: null,
        tool_args: { folded_steps: evt.folded_steps },
      };
    case "budget_warning":
      return {
        seq: evt.seq,
        iter: 0,
        kind: "budget_warning",
        tool_name: null,
        status: null,
        content: `Approaching budget — ${evt.cost_usd.toFixed(2)} of ${evt.budget_usd.toFixed(2)} used.`,
        summary: null,
        duration_ms: null,
      };
    default:
      return null;
  }
}

export default function AgentRunPage() {
  const { id } = useParams<{ id: string }>();

  const [run, setRun] = useState<AgentRun | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [pendingCard, setPendingCard] = useState<CardData | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [finalOutput, setFinalOutput] = useState<string | null>(null);
  const [finalArtifacts, setFinalArtifacts] = useState<ArtifactSummary[]>([]);
  const [connection, setConnection] = useState<AgentStreamState>("connecting");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const stepsMapRef = useRef<Map<number, AgentStep>>(new Map());
  const streamRef = useRef<AgentRunStream | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const readAloud = useReadAloud(() => finalOutput);

  // ── step map helpers ────────────────────────────────────────────────────
  const flushSteps = useCallback(() => {
    setSteps([...stepsMapRef.current.values()]);
  }, []);

  const upsertStep = useCallback(
    (step: AgentStep | null) => {
      if (!step) return;
      const map = stepsMapRef.current;
      const prev = map.get(step.seq);
      map.set(step.seq, prev ? { ...prev, ...step } : step);
      flushSteps();
    },
    [flushSteps],
  );

  const currentAfter = useCallback((): number => {
    let m = 0;
    for (const k of stepsMapRef.current.keys()) if (k > m) m = k;
    const ls = streamRef.current?.lastSeq() ?? 0;
    return Math.max(m, ls);
  }, []);

  // ── event handling ──────────────────────────────────────────────────────
  const handleEvent = useCallback(
    (evt: AgentEvent) => {
      switch (evt.type) {
        case "run_status":
          setRun((prev) =>
            prev
              ? {
                  ...prev,
                  status: evt.status,
                  iter_count: evt.iter,
                  cost_usd: evt.cost_usd,
                  budget_usd: evt.budget_usd,
                }
              : prev,
          );
          if (evt.status !== "awaiting_confirmation") setPendingCard(null);
          if (isActiveStatus(evt.status)) setStreamError(null);
          break;
        case "plan_updated":
          setPlan(evt.plan);
          break;
        case "delta":
          setStreamingText((t) => t + evt.text);
          break;
        case "assistant_message":
          setStreamingText("");
          upsertStep(stepFromEvent(evt));
          break;
        case "tool_call":
          setStreamingText("");
          upsertStep(stepFromEvent(evt));
          break;
        case "tool_result":
        case "artifact_created":
        case "confirmation_resolved":
        case "compaction":
        case "budget_warning":
          upsertStep(stepFromEvent(evt));
          if (evt.type === "confirmation_resolved") {
            setPendingCard((cur) => (cur && cur.card_id === evt.card_id ? null : cur));
          }
          break;
        case "confirmation_required":
          setStreamingText("");
          setPendingCard(evt.card);
          setRun((prev) => (prev ? { ...prev, status: "awaiting_confirmation" } : prev));
          break;
        case "run_completed":
          setStreamingText("");
          setFinalOutput(evt.final_output);
          if (Array.isArray(evt.artifacts) && evt.artifacts.length) {
            setFinalArtifacts(evt.artifacts);
          }
          setRun((prev) =>
            prev
              ? {
                  ...prev,
                  status: "completed",
                  final_output: evt.final_output,
                  cost_usd: evt.cost_usd,
                  iter_count: evt.iter_count,
                }
              : prev,
          );
          break;
        case "error":
          setStreamError(evt.message);
          break;
        case "close":
          break;
      }
    },
    [upsertStep],
  );

  // ── snapshot seed (merge; idempotent) ─────────────────────────────────────
  const applySnapshot = useCallback((snap: AgentRunDetail) => {
    const map = stepsMapRef.current;
    for (const s of snap.steps ?? []) {
      // Normalise persisted rows through the SAME path as live events so the
      // timeline sees parsed fields (e.g. assistant_message text) rather than
      // the raw stored event JSON. Fall back to the row for any unmapped kind.
      const normalised = s.event ? stepFromEvent(s.event) : null;
      const step = normalised ?? s;
      const prev = map.get(s.seq);
      map.set(s.seq, prev ? { ...prev, ...step } : { ...step });
    }
    setSteps([...map.values()]);
    setPlan(Array.isArray(snap.plan) ? snap.plan : []);
    setRun(snap);
    setPendingCard(
      snap.status === "awaiting_confirmation" ? snap.pending_confirmation ?? null : null,
    );
    if (snap.final_output) setFinalOutput(snap.final_output);
  }, []);

  // ── stream (re)start ──────────────────────────────────────────────────────
  const startStream = useCallback(
    (after: number) => {
      if (!id) return;
      streamRef.current?.stop();
      const stream = streamAgentRun({
        runId: id,
        after,
        onConnectionChange: setConnection,
        onEvent: handleEvent,
      });
      streamRef.current = stream;
      stream.start();
    },
    [id, handleEvent],
  );

  // ── mount: seed + tail (StrictMode-guarded) ───────────────────────────────
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const snap = await authFetch<AgentRunDetail>(`/api/agent/runs/${id}`);
        if (cancelled) return;
        applySnapshot(snap);
        setLoading(false);
        startStream(currentAfter());
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Could not load this run.");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.stop();
      streamRef.current = null;
    };
  }, [id, applySnapshot, startStream, currentAfter]);

  // ── resync after a lifecycle action ───────────────────────────────────────
  const resync = useCallback(async () => {
    if (!id) return;
    streamRef.current?.stop();
    try {
      const snap = await authFetch<AgentRunDetail>(`/api/agent/runs/${id}`);
      applySnapshot(snap);
    } catch {
      /* keep whatever we have; the stream will re-seed */
    }
    startStream(currentAfter());
  }, [id, applySnapshot, startStream, currentAfter]);

  const onCancel = useCallback(async () => {
    if (!id) return;
    await cancelRun(id);
    await resync();
  }, [id, resync]);

  const onPause = useCallback(async () => {
    if (!id) return;
    await pauseRun(id);
    await resync();
  }, [id, resync]);

  const onResume = useCallback(async () => {
    if (!id) return;
    await resumeRun(id);
    await resync();
  }, [id, resync]);

  const resolveCard = useCallback(
    async (action: ConfirmAction, answer?: string) => {
      if (!id || !pendingCard) return;
      await confirmCard(id, {
        card_id: pendingCard.card_id,
        action,
        ...(answer != null && answer !== "" ? { answer } : {}),
      });
      setPendingCard(null);
      await resync();
    },
    [id, pendingCard, resync],
  );

  // ── auto-scroll (stick to bottom unless the user scrolls up) ───────────────
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  }, []);
  useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [steps, streamingText, plan, pendingCard, finalOutput]);

  // ── derived artifacts for the completed report ─────────────────────────────
  const reportArtifacts = useMemo(() => {
    const byId = new Map<string, ArtifactSummary>();
    for (const s of steps) {
      if (s.kind !== "artifact_created") continue;
      const a = artifactFromStep(s);
      if (a) byId.set(a.id, a);
    }
    for (const a of finalArtifacts) byId.set(a.id, a);
    return [...byId.values()];
  }, [steps, finalArtifacts]);

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="h-screen overflow-y-auto scrollbar-thin"
    >
      <div className="mx-auto w-full max-w-3xl px-5 py-6 md:px-8">
        <div className="mb-4 pl-10 lg:pl-0">
          <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted">
            <Link to="/agent">
              <ArrowLeft />
              All runs
            </Link>
          </Button>
        </div>

        {loadError ? (
          <LoadError message={loadError} />
        ) : loading || !run ? (
          <RunSkeleton />
        ) : (
          <div className="flex flex-col gap-4">
            <RunHeader
              run={run}
              connection={connection}
              onCancel={onCancel}
              onPause={onPause}
              onResume={onResume}
            />

            {plan.length > 0 && <PlanChecklist plan={plan} className="sticky top-2 z-20" />}

            {streamError && (
              <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3.5 py-2.5 text-[13px] text-rose-600 dark:text-rose-400">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{streamError}</span>
              </div>
            )}

            <StepTimeline steps={steps} streamingText={streamingText} />

            {run.status === "awaiting_confirmation" && pendingCard && (
              <ConfirmationCard card={pendingCard} onResolve={resolveCard} />
            )}

            {run.status === "completed" && finalOutput && (
              <CompletedPanel
                output={finalOutput}
                artifacts={reportArtifacts}
                onListen={() => void readAloud.play()}
                listenDisabled={readAloud.configured === false}
              />
            )}

            {run.status === "failed" && (
              <div className="flex items-start gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/5 p-4 text-[13px] text-rose-600 dark:text-rose-400">
                <ServerCrash className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="font-medium">This run failed.</p>
                  {run.error && <p className="mt-1 text-rose-600/90 dark:text-rose-400/90">{run.error}</p>}
                  {(run.resumable === true || run.resumable === 1) && (
                    <p className="mt-1 text-muted">You can resume it from the header.</p>
                  )}
                </div>
              </div>
            )}

            <div ref={bottomRef} className="h-2" />
          </div>
        )}
      </div>

      <MiniPlayer controls={readAloud} label="Final report" />
    </div>
  );
}

// ── completed report panel ────────────────────────────────────────────────────

function CompletedPanel({
  output,
  artifacts,
  onListen,
  listenDisabled,
}: {
  output: string;
  artifacts: ArtifactSummary[];
  onListen: () => void;
  listenDisabled: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface2">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="grid size-7 place-items-center rounded-lg bg-ink text-surface">
          <Sparkles className="size-4" />
        </span>
        <span className="font-display text-sm font-semibold text-ink">Result</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={onListen}
          disabled={listenDisabled}
          title={listenDisabled ? VOICE_UNCONFIGURED_HINT : "Read the result aloud"}
        >
          <Volume2 />
          Listen
        </Button>
      </div>
      <div className="px-4 py-4">
        <MarkdownMessage content={output} />

        {artifacts.length > 0 && (
          <div className="mt-5 border-t border-line pt-4">
            <p className="eyebrow mb-2.5">Artifacts</p>
            <div className="flex flex-wrap gap-2.5">
              {artifacts.map((a) => (
                <ArtifactChip key={a.id} artifact={a} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── states ────────────────────────────────────────────────────────────────────

function LoadError({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface2 px-6 py-14 text-center">
      <div className="grid size-12 place-items-center rounded-2xl bg-rose-500/10">
        <Bot className="size-6 text-rose-500" />
      </div>
      <p className="font-display text-lg font-semibold text-ink">Couldn't load this run</p>
      <p className="max-w-sm text-sm text-muted">{message}</p>
      <Button variant="secondary" asChild>
        <Link to="/agent">Back to runs</Link>
      </Button>
    </div>
  );
}

function RunSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-32 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
      <div className="space-y-3 pl-9">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-4/5 rounded-xl" />
        <Skeleton className="h-16 w-2/3 rounded-xl" />
      </div>
    </div>
  );
}
