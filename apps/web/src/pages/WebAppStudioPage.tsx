// /tools/apps — AI Developer ("Build an app with AI"). Describe an app, pick a
// visual style, and the webapp generator streams back a COMPLETE, single-file
// HTML document. While it streams we live-preview the accumulating markup in a
// sandboxed iframe (allow-scripts only — the doc is fully self-contained). On
// the terminal artifact event we navigate to the viewer at /tools/apps/:id.
//
// Below the composer: a template gallery (browser-mock tiles rendered locally,
// so no shared TemplatePreview edit is needed) that seeds the prompt, and a
// grid of every existing kind=webpage artifact with open/delete.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  Loader2,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  useApi,
  authFetch,
  invalidateApi,
  invalidateApiPrefix,
} from "@/lib/use-api";
import { streamGenerate } from "@/lib/generate";
import {
  categoriesForKind,
  templatesForKind,
  type GenTemplate,
} from "@/lib/templates";
import type { ArtifactSummary } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eyebrow } from "@/components/brand/Eyebrow";

const LIST_PATH = "/api/artifacts?kind=webpage&limit=50";

const STYLES = ["clean", "playful", "dark", "minimal"] as const;
type WebappStyle = (typeof STYLES)[number];

const STYLE_LABEL: Record<WebappStyle, string> = {
  clean: "Clean & modern",
  playful: "Playful & vibrant",
  dark: "Sleek dark",
  minimal: "Minimal",
};

// Throttle interval for pushing accumulating html into the live preview.
const PREVIEW_INTERVAL_MS = 250;

export default function WebAppStudioPage() {
  const navigate = useNavigate();

  const { data, isInitialLoading } = useApi<{ artifacts: ArtifactSummary[] }>(LIST_PATH);
  // Exclude Design Studio artifacts (they share kind "webpage").
  const apps = (data?.artifacts ?? []).filter((a) => a.meta?.subtype !== "design");

  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState<WebappStyle>("clean");
  const [generating, setGenerating] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const accRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Abort a live generation when leaving the page.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    },
    [],
  );

  function useTemplate(t: GenTemplate) {
    if (generating) return;
    setPrompt(t.prompt);
    const s = t.extra?.style;
    if (s && (STYLES as readonly string[]).includes(s)) setStyle(s as WebappStyle);
    setGenError(null);
    requestAnimationFrame(() => {
      promptRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      promptRef.current?.focus();
    });
  }

  async function generate() {
    const trimmed = prompt.trim();
    if (!trimmed || generating) return;
    setGenerating(true);
    setGenError(null);
    setStatusLabel("Starting…");
    setPreviewHtml("");
    accRef.current = "";
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamGenerate({
        name: "webapp",
        body: { prompt: trimmed, style },
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === "status") {
            setStatusLabel(e.label);
          } else if (e.type === "delta" && e.channel === "html") {
            accRef.current += e.data;
            // Throttle iframe srcDoc churn — a full re-parse per token is janky.
            if (!flushTimerRef.current) {
              flushTimerRef.current = setTimeout(() => {
                flushTimerRef.current = null;
                setPreviewHtml(accRef.current);
              }, PREVIEW_INTERVAL_MS);
            }
          } else if (e.type === "artifact") {
            void invalidateApi(LIST_PATH);
            void invalidateApiPrefix("/api/artifacts");
            navigate(`/tools/apps/${e.artifact.id}`);
          } else if (e.type === "error") {
            setGenError(e.message);
          }
        },
      });
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setGenError(err instanceof Error ? err.message : "Generation failed.");
      }
    } finally {
      setGenerating(false);
      setStatusLabel(null);
    }
  }

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
        <Eyebrow>AI DEVELOPER</Eyebrow>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Build an app with <span className="grad-word">AI</span>
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-sm text-muted">
          Describe a page or app and get a complete, working single-file web app —
          previewed live, with the code in reach.
        </p>
      </div>

      {/* Composer */}
      <div className="rounded-2xl border border-line bg-surface2 p-4">
        <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
          Describe your app
          <Textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void generate();
              }
            }}
            placeholder="A pomodoro timer with a circular progress ring, start/pause/reset, and a short-break mode…"
            rows={4}
            maxLength={8000}
            disabled={generating}
          />
        </label>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium text-ink">
            Style
            <Select
              value={style}
              onValueChange={(v) => setStyle(v as WebappStyle)}
              disabled={generating}
            >
              <SelectTrigger aria-label="Visual style">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STYLES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STYLE_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button
            className="sm:w-44"
            onClick={() => void generate()}
            disabled={!prompt.trim() || generating}
          >
            {generating ? (
              <>
                <Loader2 className="animate-spin" />
                {statusLabel ?? "Generating…"}
              </>
            ) : (
              <>
                <Sparkles />
                Generate app
              </>
            )}
          </Button>
        </div>
        {genError && (
          <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{genError}</p>
        )}
      </div>

      {/* Live streaming preview */}
      {generating && (
        <div className="mt-4 overflow-hidden rounded-2xl border border-accent/30 bg-surface">
          <div className="flex items-center gap-2 border-b border-line bg-surface2 px-3 py-2">
            <span className="flex gap-1.5">
              <span className="size-2.5 rounded-full bg-rose-400/70" />
              <span className="size-2.5 rounded-full bg-amber-400/70" />
              <span className="size-2.5 rounded-full bg-emerald-400/70" />
            </span>
            <span className="ml-1 inline-flex items-center gap-1.5 text-xs font-medium text-muted">
              <Loader2 className="size-3.5 animate-spin text-accent" />
              {statusLabel ?? "Building…"}
            </span>
          </div>
          {previewHtml ? (
            <iframe
              title="Live preview"
              srcDoc={previewHtml}
              sandbox="allow-scripts allow-same-origin"
              className="h-[60vh] w-full bg-white"
            />
          ) : (
            <div className="grid h-[60vh] place-items-center bg-surface">
              <div className="flex flex-col items-center gap-2 text-muted">
                <Code2 className="size-6 animate-pulse text-accent" />
                <span className="text-xs">Writing your app…</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Existing web apps */}
      <div className="mt-10">
        <Eyebrow className="mb-3">Your apps</Eyebrow>
        {isInitialLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
        ) : apps.length === 0 && !generating ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line py-14 text-center">
            <div className="grid size-12 place-items-center rounded-lg bg-ink text-surface">
              <Code2 className="size-6" />
            </div>
            <p className="font-display text-lg font-semibold text-ink">No apps yet</p>
            <p className="max-w-xs text-sm text-muted">
              Describe something above — or start from a template below — to build
              your first web app.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {apps.map((a, i) => (
              <WebAppCard
                key={a.id}
                artifact={a}
                index={i}
                onOpen={() => navigate(`/tools/apps/${a.id}`)}
                listPath={LIST_PATH}
              />
            ))}
          </div>
        )}
      </div>

      {/* Template gallery (local browser-mock tiles) */}
      <WebAppTemplateGallery onUse={useTemplate} />
    </div>
  );
}

// ── Existing-app card ──────────────────────────────────────────────────────

function WebAppCard({
  artifact,
  index,
  onOpen,
  listPath,
}: {
  artifact: ArtifactSummary;
  index: number;
  onOpen: () => void;
  listPath: string;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const style =
    typeof artifact.meta?.style === "string" ? (artifact.meta.style as string) : null;

  async function remove(e: React.MouseEvent) {
    e.stopPropagation();
    const ok = await confirm({
      title: "Delete app?",
      message: <>“{artifact.title}” will be permanently removed. This can't be undone.</>,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await authFetch(`/api/artifacts/${artifact.id}`, { method: "DELETE" });
      void invalidateApi(listPath);
      void invalidateApiPrefix("/api/artifacts");
    } catch {
      setBusy(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.24) }}
    >
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full flex-col overflow-hidden rounded-xl border border-line bg-surface2 text-left outline-none transition hover:border-accent/40 focus-visible:ring-2 focus-visible:ring-accent/50"
        aria-label={`Open ${artifact.title}`}
      >
        <BrowserMock title={artifact.title} />
        <div className="flex items-center gap-2 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink group-hover:text-accent">
              {artifact.title || "Untitled app"}
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
              {style && (
                <span className="rounded-full border border-line bg-surface px-1.5 py-0.5 uppercase tracking-wide">
                  {style}
                </span>
              )}
              {timeAgo(artifact.created_at)}
            </p>
          </div>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => void remove(e)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void remove(e as unknown as React.MouseEvent);
              }
            }}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-rose-500/10 hover:text-rose-500"
            aria-label={`Delete ${artifact.title}`}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
          </span>
        </div>
      </button>
    </motion.div>
  );
}

// A static mini browser-window mock used as a thumbnail (the blob can't be
// framed without an auth header, so we sketch rather than embed).
function BrowserMock({ title }: { title: string }) {
  return (
    <div className="border-b border-line bg-surface">
      <div className="flex items-center gap-1.5 border-b border-line bg-surface2 px-2.5 py-1.5">
        <span className="size-2 rounded-full bg-rose-400/70" />
        <span className="size-2 rounded-full bg-amber-400/70" />
        <span className="size-2 rounded-full bg-emerald-400/70" />
        <span className="ml-2 truncate rounded bg-ink/5 px-2 py-0.5 text-[10px] text-muted">
          {title || "app"}
        </span>
      </div>
      <div className="relative aspect-[16/9] overflow-hidden bg-surface2 p-3">
        <div className="h-2.5 w-1/3 rounded-full bg-ink/70" />
        <div className="mt-2 h-1.5 w-4/5 rounded-full bg-ink/10" />
        <div className="mt-1 h-1.5 w-3/5 rounded-full bg-ink/10" />
        <div className="mt-3 flex gap-2">
          <div className="h-8 w-16 rounded-md bg-ink/10" />
          <div className="h-8 w-16 rounded-md bg-ink/[0.06]" />
        </div>
        <div className="absolute bottom-3 right-3 grid size-8 place-items-center rounded-lg bg-ink text-surface">
          <Code2 className="size-4" />
        </div>
      </div>
    </div>
  );
}

// ── Local template gallery ──────────────────────────────────────────────────

function WebAppTemplateGallery({ onUse }: { onUse: (t: GenTemplate) => void }) {
  const categories = categoriesForKind("webapp");
  const [active, setActive] = useState("All");
  const all = templatesForKind("webapp");
  const templates = active === "All" ? all : all.filter((t) => t.category === active);

  return (
    <section className="mt-12">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Eyebrow>Start from a template</Eyebrow>
        <div className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setActive(c)}
              aria-pressed={active === c}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium transition",
                active === c
                  ? "bg-ink text-surface"
                  : "border border-line bg-surface2 text-muted hover:border-accent/40 hover:text-ink",
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        {templates.map((t, i) => (
          <motion.button
            key={t.id}
            type="button"
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: Math.min(i * 0.03, 0.24) }}
            onClick={() => onUse(t)}
            className="group flex flex-col overflow-hidden rounded-xl border border-line bg-surface2 p-2.5 text-left outline-none transition hover:border-accent/40 focus-visible:ring-2 focus-visible:ring-accent/50"
            aria-label={`Use template: ${t.title}`}
          >
            <div className="relative">
              <WebAppTemplateTile accent={t.accent} />
              <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-gradient-to-t from-black/55 to-transparent px-2 py-2 text-[11px] font-semibold text-white opacity-0 transition group-hover:opacity-100">
                Use template
                <ArrowRight className="size-3 transition group-hover:translate-x-0.5" />
              </span>
            </div>
            <div className="mt-2 px-0.5 pb-0.5">
              <p className="truncate text-sm font-medium text-ink group-hover:text-accent">
                {t.title}
              </p>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="rounded-full border border-line bg-surface px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                  {t.category}
                </span>
                <span className="truncate text-[11px] text-muted">{t.description}</span>
              </div>
            </div>
          </motion.button>
        ))}
      </div>
    </section>
  );
}

// A mini browser-window mock tinted with the template accent.
function WebAppTemplateTile({ accent }: { accent: string }) {
  return (
    <div className="relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-1 border-b border-line bg-surface2 px-2 py-1.5">
        <span className="size-1.5 rounded-full bg-ink/20" />
        <span className="size-1.5 rounded-full bg-ink/20" />
        <span className="size-1.5 rounded-full bg-ink/20" />
      </div>
      <div className="p-2.5">
        <div className={cn("h-2 w-1/2 rounded-full bg-gradient-to-r", accent)} />
        <div className="mt-2 h-1.5 w-full rounded-full bg-ink/10" />
        <div className="mt-1 h-1.5 w-4/5 rounded-full bg-ink/10" />
        <div className="mt-2.5 flex gap-1.5">
          <div className={cn("h-5 w-12 rounded bg-gradient-to-r", accent)} />
          <div className="h-5 w-12 rounded bg-ink/[0.07]" />
        </div>
      </div>
    </div>
  );
}
