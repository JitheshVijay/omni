// /research: Deep Research. Enter a question; Omni fans out web searches,
// reads the top sources, and synthesises a cited markdown report streamed
// into a live preview. A progress panel tracks each step; on completion the
// report persists as a doc artifact and opens in the editor. Recent research
// runs (docs with meta.subtype === "research") show as cards below.

import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  ArrowRight,
  Check,
  ExternalLink,
  FileSearch,
  Loader2,
  Search,
  Sparkles,
} from "lucide-react";
import { useApi } from "@/lib/use-api";
import { streamResearch } from "@/lib/research";
import type { ArtifactSummary } from "@/lib/types";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Eyebrow } from "@/components/brand/Eyebrow";
import { HeroBand } from "@/components/brand/HeroBand";
import { WordmarkBanner } from "@/components/brand/WordmarkBanner";

const EXAMPLES = [
  "How are small modular nuclear reactors being commercialized in 2026?",
  "What does the latest research say about GLP-1 drugs and muscle loss?",
  "Compare the leading open-weight LLMs for on-device inference.",
  "What are the economic effects of a four-day work week?",
];

interface ProgressStep {
  id: number;
  label: string;
}

type Phase = "idle" | "running" | "done" | "error";

export default function ResearchPage() {
  const navigate = useNavigate();
  const [question, setQuestion] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [steps, setSteps] = useState<ProgressStep[]>([]);
  const [report, setReport] = useState("");
  const [artifact, setArtifact] = useState<ArtifactSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // StrictMode double-invoke + double-submit guard.
  const runningRef = useRef(false);
  const stepSeq = useRef(0);

  const { data, isInitialLoading, mutate } = useApi<{ artifacts: ArtifactSummary[] }>(
    "/api/artifacts?kind=doc&limit=50",
  );
  const recent = useMemo(
    () => (data?.artifacts ?? []).filter((a) => a.meta?.subtype === "research"),
    [data],
  );

  const submit = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (q.length < 3 || runningRef.current) return;
      runningRef.current = true;

      setPhase("running");
      setSteps([]);
      setReport("");
      setArtifact(null);
      setError(null);
      stepSeq.current = 0;

      try {
        await streamResearch({
          question: q,
          onEvent: (evt) => {
            if (evt.type === "status") {
              setSteps((prev) => [
                ...prev,
                { id: stepSeq.current++, label: evt.label },
              ]);
            } else if (evt.type === "delta" && evt.channel === "markdown") {
              if (typeof evt.data === "string") {
                setReport((prev) => prev + evt.data);
              }
            } else if (evt.type === "artifact") {
              setArtifact(evt.artifact);
              setPhase("done");
              void mutate();
            } else if (evt.type === "error") {
              setError(evt.message);
              setPhase("error");
            }
          },
        });
      } catch (err) {
        setError((err as Error).message || "Research failed");
        setPhase("error");
      } finally {
        runningRef.current = false;
      }
    },
    [mutate],
  );

  const started = phase !== "idle";

  return (
    <div className="mx-auto flex h-screen w-full max-w-4xl flex-col overflow-y-auto scrollbar-thin px-6 py-10 md:px-10">
      {/* Hero */}
      {!started && (
        <HeroBand className="mb-8 text-center">
          <Eyebrow>Deep research</Eyebrow>
          <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Research <span className="grad-word">anything, deeply</span>
          </h1>
          <p className="mx-auto mt-3 max-w-md text-sm text-muted">
            Ask a question and Omni fans out multiple web searches, reads the top
            sources, and writes a cited report you can keep.
          </p>
        </HeroBand>
      )}

      {/* Question input */}
      <div className={started ? "mb-6" : "mb-4"}>
        <QuestionInput
          value={question}
          onChange={setQuestion}
          onSubmit={() => submit(question)}
          disabled={phase === "running"}
          compact={started}
        />
        {!started && (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => {
                  setQuestion(ex);
                  void submit(ex);
                }}
                className="rounded-full border border-line bg-surface2 px-3 py-1.5 text-xs text-muted transition hover:border-accent/40 hover:text-ink"
              >
                {ex}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Live run: progress + streaming report */}
      {started && (
        <div className="space-y-5">
          <ProgressPanel steps={steps} phase={phase} />

          {error && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-600 dark:text-rose-400">
              {error}
            </div>
          )}

          {(report || phase === "running") && (
            <div className="rounded-2xl border border-line bg-surface2 p-5 md:p-6">
              <div className="mb-3 flex items-center justify-between gap-3">
                <Eyebrow>{phase === "done" ? "Report" : "Drafting report"}</Eyebrow>
                {artifact && (
                  <Button
                    size="sm"
                    onClick={() => navigate(`/tools/docs/${artifact.id}`)}
                  >
                    Open in editor
                    <ExternalLink className="size-3.5" />
                  </Button>
                )}
              </div>
              {report ? (
                <MarkdownMessage content={report} />
              ) : (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Recent research */}
      {!started && (
        <div className="mt-10">
          <Eyebrow className="mb-3">Recent research</Eyebrow>
          {isInitialLoading ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-28 rounded-xl" />
              ))}
            </div>
          ) : recent.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line py-10 text-center">
              <div className="grid size-11 place-items-center rounded-lg bg-ink text-surface">
                <Sparkles className="size-5" />
              </div>
              <p className="text-sm font-medium text-ink">No research yet</p>
              <p className="max-w-xs text-xs text-muted">
                Ask a question above, and every report you run shows up here and in
                your Library.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {recent.map((a) => (
                <ResearchCard
                  key={a.id}
                  artifact={a}
                  onOpen={() => navigate(`/tools/docs/${a.id}`)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {!started && <WordmarkBanner />}
    </div>
  );
}

function QuestionInput({
  value,
  onChange,
  onSubmit,
  disabled,
  compact,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  compact: boolean;
}) {
  return (
    <div
      className={`mx-auto flex w-full items-center gap-2 rounded-2xl border border-line bg-surface2 px-3 transition focus-within:border-accent/50 ${
        compact ? "max-w-full py-1.5" : "max-w-2xl py-2"
      }`}
    >
      <Search className="ml-1 size-5 shrink-0 text-muted" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder="Ask anything. Omni will research it deeply..."
        className="min-w-0 flex-1 bg-transparent py-2 text-[15px] text-ink outline-none placeholder:text-muted"
      />
      <Button
        onClick={onSubmit}
        disabled={disabled || value.trim().length < 3}
        className="shrink-0"
      >
        {disabled ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Researching
          </>
        ) : (
          <>
            Research
            <ArrowRight className="size-4" />
          </>
        )}
      </Button>
    </div>
  );
}

function ProgressPanel({
  steps,
  phase,
}: {
  steps: ProgressStep[];
  phase: Phase;
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface2/60 p-4">
      <h2 className="mb-3 flex items-center gap-2 font-display text-sm font-semibold text-ink">
        <Sparkles className="size-4 text-accent" />
        Research progress
      </h2>
      <ol className="space-y-2">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1;
          const active = isLast && phase === "running";
          return (
            <motion.li
              key={step.id}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2 }}
              className="flex items-center gap-2.5 text-sm"
            >
              <span className="grid size-5 shrink-0 place-items-center">
                {active ? (
                  <Loader2 className="size-4 animate-spin text-accent" />
                ) : (
                  <Check className="size-4 text-emerald-400" />
                )}
              </span>
              <span className={active ? "text-ink" : "text-muted"}>
                {step.label}
              </span>
            </motion.li>
          );
        })}
        {steps.length === 0 && (
          <li className="flex items-center gap-2.5 text-sm text-muted">
            <Loader2 className="size-4 animate-spin text-accent" />
            Starting…
          </li>
        )}
      </ol>
    </div>
  );
}

function ResearchCard({
  artifact,
  onOpen,
}: {
  artifact: ArtifactSummary;
  onOpen: () => void;
}) {
  const question =
    typeof artifact.meta?.question === "string" ? artifact.meta.question : null;
  const count =
    typeof artifact.meta?.source_count === "number"
      ? artifact.meta.source_count
      : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full flex-col rounded-lg border border-line bg-surface2 p-4 text-left transition hover:border-accent/40"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-ink text-surface">
          <FileSearch className="size-4" />
        </div>
        <ExternalLink className="size-4 text-muted opacity-0 transition group-hover:opacity-100" />
      </div>
      <h3 className="line-clamp-2 font-display text-sm font-semibold text-ink group-hover:text-accent">
        {artifact.title}
      </h3>
      {question && (
        <p className="mt-1 line-clamp-2 text-xs text-muted">{question}</p>
      )}
      <div className="mt-auto pt-3 text-[11px] text-muted">
        {count != null ? `${count} sources` : "Report"} ·{" "}
        {new Date(artifact.created_at).toLocaleDateString()}
      </div>
    </button>
  );
}
