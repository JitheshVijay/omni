// /tools/fullstack: the App Builder. Describe a full-stack app and the builder
// streams back progress (Designing…, Provisioning cloud sandbox…, Installing
// dependencies…, Starting the dev server…, Live.) plus dev-server logs while it
// generates the code, provisions an E2B sandbox, and boots the dev server. On
// the terminal `project` event we navigate to the viewer at /tools/fullstack/:id.
//
// Below the composer: a grid of every existing project from
// GET /api/fullstack/projects, each linking to its viewer.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowLeft, Boxes, Check, ChevronRight, Loader2, Rocket, Terminal } from "lucide-react";
import { useApi, invalidateApi } from "@/lib/use-api";
import {
  streamFullstackBuild,
  STATUS_META,
  type FullstackProject,
} from "@/lib/fullstack";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Eyebrow } from "@/components/brand/Eyebrow";

const LIST_PATH = "/api/fullstack/projects";

export default function FullstackStudioPage() {
  const navigate = useNavigate();

  const { data, isInitialLoading } = useApi<{ projects: FullstackProject[] }>(LIST_PATH);
  const projects = data?.projects ?? [];

  const [prompt, setPrompt] = useState("");
  const [building, setBuilding] = useState(false);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  // Abort a live build when leaving the page.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Keep the log tail pinned to the newest line.
  useEffect(() => {
    if (logsOpen && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, logsOpen]);

  async function build() {
    const trimmed = prompt.trim();
    if (!trimmed || building) return;
    setBuilding(true);
    setBuildError(null);
    setStatuses([]);
    setFiles([]);
    setLogs([]);
    idRef.current = null;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamFullstackBuild({
        prompt: trimmed,
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === "created") {
            idRef.current = e.id;
          } else if (e.type === "status") {
            setStatuses((s) => [...s, e.label]);
          } else if (e.type === "file") {
            setFiles((f) => [...f, e.path]);
          } else if (e.type === "log") {
            setLogs((l) => [...l, e.line]);
          } else if (e.type === "project") {
            void invalidateApi(LIST_PATH);
            const { id, status } = e.project;
            if (status === "ready" || status === "no_sandbox" || status === "failed") {
              navigate(`/tools/fullstack/${idRef.current ?? id}`);
            }
          } else if (e.type === "error") {
            setBuildError(e.message);
          }
        },
      });
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setBuildError(err instanceof Error ? err.message : "Build failed.");
      }
    } finally {
      setBuilding(false);
    }
  }

  const currentStatus = statuses[statuses.length - 1];

  return (
    <div className="mx-auto flex h-screen w-full max-w-6xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      <div className="mb-4 pl-10 lg:pl-0">
        <Button variant="ghost" size="iconSm" asChild aria-label="Back to Tools">
          <Link to="/tools">
            <ArrowLeft />
          </Link>
        </Button>
      </div>

      <div className="mb-6 text-center">
        <Eyebrow>APP BUILDER</Eyebrow>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Build a <span className="grad-word">full-stack</span> app
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-sm text-muted">
          Describe a complete app, frontend, backend, and database, and run it live
          in a cloud sandbox.
        </p>
      </div>

      {/* Composer */}
      <div className="rounded-2xl border border-line bg-surface2 p-4">
        <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
          Describe your app
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void build();
              }
            }}
            placeholder="A habit tracker with daily check-ins, streaks, and a chart, saved to a database…"
            rows={4}
            maxLength={8000}
            disabled={building}
          />
        </label>
        <div className="mt-3 flex justify-end">
          <Button
            className="sm:w-44"
            onClick={() => void build()}
            disabled={!prompt.trim() || building}
          >
            {building ? (
              <>
                <Loader2 className="animate-spin" />
                {currentStatus ?? "Building…"}
              </>
            ) : (
              <>
                <Rocket />
                Build app
              </>
            )}
          </Button>
        </div>
        {buildError && (
          <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{buildError}</p>
        )}
      </div>

      {/* Live build progress */}
      {building && (
        <div className="mt-4 overflow-hidden rounded-2xl border border-accent/30 bg-surface">
          <div className="flex items-center gap-2 border-b border-line bg-surface2 px-3 py-2">
            <span className="flex gap-1.5">
              <span className="size-2.5 rounded-full bg-rose-400/70" />
              <span className="size-2.5 rounded-full bg-amber-400/70" />
              <span className="size-2.5 rounded-full bg-emerald-400/70" />
            </span>
            <span className="ml-1 inline-flex items-center gap-1.5 text-xs font-medium text-muted">
              <Loader2 className="size-3.5 animate-spin text-accent" />
              {currentStatus ?? "Building your app…"}
            </span>
          </div>

          <div className="p-4">
            <ol className="flex flex-col gap-2">
              {statuses.map((label, i) => {
                const isLast = i === statuses.length - 1;
                return (
                  <li key={i} className="flex items-center gap-2 text-sm text-ink">
                    {isLast ? (
                      <Loader2 className="size-4 shrink-0 animate-spin text-accent" />
                    ) : (
                      <Check className="size-4 shrink-0 text-emerald-500" />
                    )}
                    <span className={cn(isLast ? "text-ink" : "text-muted")}>{label}</span>
                  </li>
                );
              })}
              {statuses.length === 0 && (
                <li className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="size-4 shrink-0 animate-spin text-accent" />
                  Getting started…
                </li>
              )}
            </ol>

            {files.length > 0 && (
              <div className="mt-4 rounded-lg border border-line bg-surface2 px-3 py-2.5">
                <div className="mb-1.5 text-[11px] font-medium text-muted">
                  Writing files <span className="tabular-nums">({files.length})</span>
                </div>
                <ul className="flex flex-col gap-1 font-mono text-[11px] text-muted">
                  {files.slice(-14).map((p, i) => (
                    <li key={`${p}-${i}`} className="flex items-center gap-1.5">
                      <Check className="size-3 shrink-0 text-emerald-500" />
                      <span className="truncate">{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {logs.length > 0 && (
              <div className="mt-4 rounded-lg border border-line bg-surface2">
                <button
                  type="button"
                  onClick={() => setLogsOpen((v) => !v)}
                  aria-expanded={logsOpen}
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] font-medium text-muted transition hover:text-ink"
                >
                  <ChevronRight className={cn("size-3 transition-transform", logsOpen && "rotate-90")} />
                  <Terminal className="size-3.5" />
                  {logsOpen ? "Hide logs" : "Show logs"}
                  <span className="tabular-nums">({logs.length})</span>
                </button>
                {logsOpen && (
                  <pre
                    ref={logRef}
                    className="max-h-56 overflow-auto scrollbar-thin border-t border-line px-3 py-2.5 font-mono text-[11px] leading-relaxed text-muted"
                  >
                    {logs.join("\n")}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Existing projects */}
      <div className="mt-10">
        <Eyebrow className="mb-3">Your apps</Eyebrow>
        {isInitialLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-lg" />
            ))}
          </div>
        ) : projects.length === 0 && !building ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line py-14 text-center">
            <div className="grid size-12 place-items-center rounded-lg bg-ink text-surface">
              <Boxes className="size-6" />
            </div>
            <p className="font-display text-lg font-semibold text-ink">No apps yet</p>
            <p className="max-w-xs text-sm text-muted">
              Describe something above to build your first full-stack app.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p, i) => (
              <FullstackAppCard
                key={p.id}
                project={p}
                index={i}
                onOpen={() => navigate(`/tools/fullstack/${p.id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Existing-project card ──────────────────────────────────────────────────

function FullstackAppCard({
  project,
  index,
  onOpen,
}: {
  project: FullstackProject;
  index: number;
  onOpen: () => void;
}) {
  const meta = STATUS_META[project.status] ?? STATUS_META.queued;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.24) }}
    >
      <button
        type="button"
        onClick={onOpen}
        className="group flex h-full w-full flex-col rounded-lg border border-line bg-surface2 p-5 text-left outline-none transition hover:border-accent/40 focus-visible:ring-2 focus-visible:ring-accent/50"
        aria-label={`Open ${project.name}`}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="grid size-11 place-items-center rounded-lg bg-ink text-surface transition group-hover:scale-105">
            <Boxes className="size-5" />
          </div>
          <Badge variant={meta.variant}>
            {meta.building && <Loader2 className="size-3 animate-spin" />}
            {meta.label}
          </Badge>
        </div>
        <h2 className="truncate font-display text-base font-semibold text-ink group-hover:text-accent">
          {project.name || "Untitled app"}
        </h2>
        <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted">
          {project.summary || "No description."}
        </p>
        <p className="mt-2 text-[11px] text-muted">{timeAgo(project.created_at)}</p>
      </button>
    </motion.div>
  );
}
