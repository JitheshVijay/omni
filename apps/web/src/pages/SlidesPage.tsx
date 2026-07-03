// /tools/slides — AI Slides home. A "New deck" panel (prompt + slide count +
// theme + optional hub grounding) streams streamGenerate("slides") INLINE,
// showing a live outline checklist as each slide is designed; on the terminal
// artifact event it navigates to the deck editor (/tools/slides/:id). Below is
// a gallery of existing kind=slides decks.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  ArrowLeft,
  Check,
  FolderKanban,
  Layers,
  Loader2,
  Presentation,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useApi, authFetch, invalidateApiPrefix } from "@/lib/use-api";
import { streamGenerate } from "@/lib/generate";
import type { ArtifactSummary, Hub } from "@/lib/types";
import {
  ARCHETYPE_LABEL,
  THEME_PRESETS,
  type Archetype,
  type ThemePreset,
} from "@/lib/slide-types";
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

const LIST_PATH = "/api/artifacts?kind=slides&limit=50";
const NO_HUB = "__none__";
const MIN_SLIDES = 4;
const MAX_SLIDES = 20;

interface OutlinePreview {
  title: string;
  slides: { title: string; archetype: Archetype }[];
}

function presetFor(id: unknown): ThemePreset {
  return THEME_PRESETS.find((p) => p.id === id) ?? THEME_PRESETS[0];
}

export default function SlidesPage() {
  const navigate = useNavigate();
  const { data, isInitialLoading } = useApi<{ artifacts: ArtifactSummary[] }>(LIST_PATH);
  const decks = data?.artifacts ?? [];
  const { data: hubsData } = useApi<{ hubs: Hub[] }>("/api/hubs");
  const hubs = hubsData?.hubs ?? [];

  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(8);
  const [themeId, setThemeId] = useState("midnight");
  const [hubId, setHubId] = useState<string>(NO_HUB);

  const [generating, setGenerating] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [outline, setOutline] = useState<OutlinePreview | null>(null);
  const [doneCount, setDoneCount] = useState(0);
  const [genError, setGenError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function generate() {
    const trimmed = prompt.trim();
    if (!trimmed || generating) return;
    setGenerating(true);
    setGenError(null);
    setOutline(null);
    setDoneCount(0);
    setStatusLabel("Starting…");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamGenerate({
        name: "slides",
        body: {
          prompt: trimmed,
          slide_count: count,
          theme: themeId,
          ...(hubId === NO_HUB ? {} : { hub_id: hubId }),
        },
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === "status") {
            setStatusLabel(e.label);
          } else if (e.type === "delta" && e.channel === "outline") {
            try {
              setOutline(JSON.parse(String(e.data)) as OutlinePreview);
            } catch {
              /* ignore malformed */
            }
          } else if (e.type === "delta" && e.channel === "slide_done") {
            try {
              const idx = Number((JSON.parse(String(e.data)) as { index: number }).index);
              if (Number.isFinite(idx)) setDoneCount((c) => Math.max(c, idx + 1));
            } catch {
              /* ignore */
            }
          } else if (e.type === "artifact") {
            void invalidateApiPrefix("/api/artifacts");
            navigate(`/tools/slides/${e.artifact.id}`);
          } else if (e.type === "error") {
            setGenError(e.message);
            setGenerating(false);
          }
        },
      });
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setGenError(err instanceof Error ? err.message : "Generation failed.");
      }
    } finally {
      if (!ctrl.signal.aborted) {
        setGenerating(false);
        setStatusLabel(null);
      }
    }
  }

  const activePreset = presetFor(themeId);

  return (
    <div className="mx-auto flex h-screen w-full max-w-5xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      <div className="mb-6 flex items-center gap-3 pl-10 lg:pl-0">
        <Button variant="ghost" size="iconSm" asChild aria-label="Back to Tools">
          <Link to="/tools">
            <ArrowLeft />
          </Link>
        </Button>
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
            AI Slides
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Describe a talk — Omni designs a polished, on-brand deck with real
            charts and generated slide art.
          </p>
        </div>
      </div>

      {/* New deck panel */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="rounded-2xl border border-line bg-gradient-to-b from-accent/[0.05] to-transparent p-5"
      >
        <div className="mb-3 flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent2 text-white shadow-sm">
            <Presentation className="size-4" />
          </div>
          <h2 className="font-display text-base font-semibold text-ink">New deck</h2>
        </div>

        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void generate();
            }
          }}
          placeholder="What's the deck about? e.g. “A 10-slide investor pitch for a home-battery startup: problem, market, product, traction, and the ask”"
          rows={3}
          maxLength={8000}
          disabled={generating}
          className="bg-surface2"
        />

        <div className="mt-3 flex flex-wrap items-end gap-4">
          {/* Slide count stepper */}
          <div className="flex flex-col gap-1.5 text-xs font-medium text-muted">
            Slides
            <div className="inline-flex items-center rounded-lg border border-line bg-surface2 p-0.5 shadow-sm">
              <button
                type="button"
                onClick={() => setCount((c) => Math.max(MIN_SLIDES, c - 1))}
                disabled={generating || count <= MIN_SLIDES}
                aria-label="Fewer slides"
                className="grid size-7 place-items-center rounded-md text-base text-muted transition hover:bg-ink/5 hover:text-ink disabled:opacity-40"
              >
                −
              </button>
              <span className="w-8 text-center text-sm font-semibold tabular-nums text-ink">
                {count}
              </span>
              <button
                type="button"
                onClick={() => setCount((c) => Math.min(MAX_SLIDES, c + 1))}
                disabled={generating || count >= MAX_SLIDES}
                aria-label="More slides"
                className="grid size-7 place-items-center rounded-md text-base text-muted transition hover:bg-ink/5 hover:text-ink disabled:opacity-40"
              >
                +
              </button>
            </div>
          </div>

          {/* Theme swatches */}
          <div className="flex flex-col gap-1.5 text-xs font-medium text-muted">
            Theme
            <div className="flex gap-1.5">
              {THEME_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setThemeId(p.id)}
                  disabled={generating}
                  title={p.name}
                  aria-label={p.name}
                  aria-pressed={themeId === p.id}
                  className={cn(
                    "relative h-9 w-12 overflow-hidden rounded-lg ring-1 transition disabled:opacity-60",
                    themeId === p.id
                      ? "ring-2 ring-accent"
                      : "ring-line hover:ring-accent/50",
                  )}
                  style={{ background: p.swatch[0] }}
                >
                  <span
                    className="absolute bottom-1 left-1 size-2.5 rounded-full"
                    style={{ background: p.swatch[1] }}
                  />
                  <span
                    className="absolute bottom-1 left-4 size-2.5 rounded-full"
                    style={{ background: p.swatch[2] }}
                  />
                  {themeId === p.id && (
                    <Check className="absolute right-1 top-1 size-3 text-white drop-shadow" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Hub grounding */}
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
            Ground in a hub <span className="font-normal">(optional)</span>
            <Select value={hubId} onValueChange={setHubId} disabled={generating}>
              <SelectTrigger className="h-9 w-48" aria-label="Hub">
                <FolderKanban className="size-3.5 shrink-0 text-muted" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_HUB}>No hub</SelectItem>
                {hubs.map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    {h.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <Button
            className="ml-auto"
            onClick={() => void generate()}
            disabled={!prompt.trim() || generating}
          >
            {generating ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {generating ? "Designing…" : "Generate deck"}
          </Button>
        </div>

        {genError && (
          <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{genError}</p>
        )}
      </motion.div>

      {/* Live progress */}
      {generating && (
        <GenerationProgress
          statusLabel={statusLabel}
          outline={outline}
          doneCount={doneCount}
          total={outline?.slides.length ?? count}
          preset={activePreset}
        />
      )}

      {/* Existing decks */}
      <div className="mt-8">
        <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wider text-muted">
          Your decks
        </h2>
        {isInitialLoading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[16/10] w-full rounded-xl" />
            ))}
          </div>
        ) : decks.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line py-14 text-center">
            <div className="grid size-11 place-items-center rounded-2xl bg-accent/10">
              <Presentation className="size-5 text-accent" />
            </div>
            <p className="text-sm font-medium text-ink">No decks yet</p>
            <p className="max-w-xs text-xs text-muted">
              Describe a talk above — Omni outlines it, then designs every slide
              with charts and art.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {decks.map((deck, i) => (
              <DeckCard key={deck.id} deck={deck} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Live outline checklist ─────────────────────────────────────────

function GenerationProgress({
  statusLabel,
  outline,
  doneCount,
  total,
  preset,
}: {
  statusLabel: string | null;
  outline: OutlinePreview | null;
  doneCount: number;
  total: number;
  preset: ThemePreset;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface2"
    >
      <div className="flex items-center gap-3 border-b border-line px-5 py-3">
        <Loader2 className="size-4 shrink-0 animate-spin text-accent" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">
            {outline?.title ?? "Designing your deck"}
          </p>
          <p className="truncate text-xs text-muted">{statusLabel ?? "Working…"}</p>
        </div>
        <span className="shrink-0 text-xs font-semibold tabular-nums text-muted">
          {Math.min(doneCount, total)} / {total}
        </span>
      </div>
      {outline && outline.slides.length > 0 && (
        <ul className="max-h-64 space-y-0.5 overflow-y-auto scrollbar-thin p-2">
          {outline.slides.map((s, i) => {
            const done = i < doneCount;
            const active = i === doneCount;
            return (
              <li
                key={i}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition",
                  active && "bg-accent/[0.06]",
                )}
              >
                <span className="grid size-5 shrink-0 place-items-center">
                  {done ? (
                    <Check className="size-4 text-emerald-500" />
                  ) : active ? (
                    <Loader2 className="size-3.5 animate-spin text-accent" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-muted/40" />
                  )}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    done ? "text-ink" : active ? "text-ink" : "text-muted",
                  )}
                >
                  {s.title}
                </span>
                <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                  {ARCHETYPE_LABEL[s.archetype] ?? s.archetype}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div
        className="h-1 w-full"
        style={{ background: `${preset.swatch[1]}22` }}
        aria-hidden
      >
        <div
          className="h-full transition-all duration-500"
          style={{
            width: `${total > 0 ? Math.round((Math.min(doneCount, total) / total) * 100) : 5}%`,
            background: `linear-gradient(90deg, ${preset.swatch[1]}, ${preset.swatch[2]})`,
          }}
        />
      </div>
    </motion.div>
  );
}

// ─── Deck gallery card ──────────────────────────────────────────────

function DeckCard({ deck, index }: { deck: ArtifactSummary; index: number }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const preset = presetFor(deck.meta?.theme);
  const slideCount =
    typeof deck.meta?.slide_count === "number" ? (deck.meta.slide_count as number) : null;

  async function remove(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const ok = await confirm({
      title: "Delete deck?",
      message: <>“{deck.title || "Untitled"}” will be permanently removed.</>,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await authFetch(`/api/artifacts/${deck.id}`, { method: "DELETE" });
      void invalidateApiPrefix("/api/artifacts");
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.25) }}
    >
      <Link
        to={`/tools/slides/${deck.id}`}
        className="group block overflow-hidden rounded-xl border border-line bg-surface2 shadow-sm transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lg"
      >
        {/* Themed cover */}
        <div
          className="relative aspect-[16/9] overflow-hidden"
          style={{
            background: `linear-gradient(135deg, ${preset.swatch[0]} 0%, ${preset.swatch[0]} 55%, ${preset.swatch[1]}44 100%)`,
          }}
        >
          <span
            className="absolute left-4 top-5 h-1 w-8 rounded-full"
            style={{ background: preset.swatch[1] }}
          />
          <span
            className="absolute left-4 top-8 block h-2 w-24 rounded-full opacity-80"
            style={{ background: preset.swatch[2] }}
          />
          <span
            className="absolute left-4 top-12 block h-2 w-16 rounded-full opacity-50"
            style={{ background: preset.swatch[2] }}
          />
          <Presentation
            className="absolute bottom-3 right-3 size-5 opacity-30"
            style={{ color: preset.swatch[1] }}
          />
          {deck.parent_id && (
            <span className="absolute right-3 top-3 rounded-full bg-black/40 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur">
              revision
            </span>
          )}
          <button
            type="button"
            onClick={(e) => void remove(e)}
            disabled={busy}
            aria-label={`Delete ${deck.title || "deck"}`}
            className="absolute bottom-3 left-3 grid size-7 place-items-center rounded-md bg-black/40 text-white opacity-0 backdrop-blur transition hover:bg-rose-500/80 group-hover:opacity-100"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </button>
        </div>
        {/* Meta */}
        <div className="px-3 py-2.5">
          <p className="truncate text-sm font-medium text-ink group-hover:text-accent">
            {deck.title || "Untitled deck"}
          </p>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
            {slideCount != null && (
              <span className="inline-flex items-center gap-1">
                <Layers className="size-3" />
                {slideCount} slides
              </span>
            )}
            <span>·</span>
            <span className="capitalize">{preset.name}</span>
            <span className="ml-auto">{timeAgo(deck.created_at)}</span>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
