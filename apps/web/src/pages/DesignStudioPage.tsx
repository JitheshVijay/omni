// /tools/design — Design Studio. Describe a graphic (poster, social post, flyer,
// cover, logo…), pick a fixed-size format and a design-system palette, and the
// design generator streams back ONE complete, self-contained HTML+SVG document
// that renders a single static, print-quality graphic. While it streams we
// live-preview the accumulating markup in a sandboxed iframe, scaled to fit.
// On the terminal artifact event we navigate to the viewer at /tools/design/:id.
//
// Below the composer: a grid of existing designs (kind=webpage filtered to
// meta.subtype==="design") with open/delete, and a gallery of example prompts
// that seed the form.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  Palette,
  Shapes,
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
  CATEGORIES,
  DESIGN_TEMPLATES,
  FORMATS,
  PALETTES,
  formatsByCategory,
  getFormat,
  getPalette,
  type Category,
  type DesignPalette,
  type DesignTemplate,
} from "@/lib/design-formats";
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
import { ScaledDesignFrame } from "@/components/tools/ScaledDesignFrame";
import { Eyebrow } from "@/components/brand/Eyebrow";

const LIST_PATH = "/api/artifacts?kind=webpage&limit=50";
const PREVIEW_INTERVAL_MS = 250;

function isDesign(a: ArtifactSummary): boolean {
  return a.meta?.subtype === "design";
}

export default function DesignStudioPage() {
  const navigate = useNavigate();

  const { data, isInitialLoading } = useApi<{ artifacts: ArtifactSummary[] }>(LIST_PATH);
  const designs = useMemo(
    () => (data?.artifacts ?? []).filter(isDesign),
    [data],
  );

  const [prompt, setPrompt] = useState("");
  const [category, setCategory] = useState<Category>("Poster");
  const [formatId, setFormatId] = useState("poster");
  const [palette, setPalette] = useState<DesignPalette>("vibrant");

  const [generating, setGenerating] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const accRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const format = getFormat(formatId) ?? FORMATS[3];
  const grouped = useMemo(() => formatsByCategory(), []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    },
    [],
  );

  function pickCategory(c: Category) {
    if (generating) return;
    setCategory(c);
    // Keep the current format if it's in the new category, else pick its first.
    const inCat = grouped[c] ?? [];
    if (!inCat.some((f) => f.id === formatId) && inCat[0]) setFormatId(inCat[0].id);
  }

  function useTemplate(t: DesignTemplate) {
    if (generating) return;
    setPrompt(t.prompt);
    setCategory(t.category);
    setFormatId(t.format);
    setPalette(t.palette);
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
        name: "design",
        body: { prompt: trimmed, format: formatId, palette },
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === "status") {
            setStatusLabel(e.label);
          } else if (e.type === "delta" && e.channel === "html") {
            accRef.current += e.data;
            if (!flushTimerRef.current) {
              flushTimerRef.current = setTimeout(() => {
                flushTimerRef.current = null;
                setPreviewHtml(accRef.current);
              }, PREVIEW_INTERVAL_MS);
            }
          } else if (e.type === "artifact") {
            void invalidateApi(LIST_PATH);
            void invalidateApiPrefix("/api/artifacts");
            navigate(`/tools/design/${e.artifact.id}`);
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

  const catFormats = grouped[category] ?? [];

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
        <Eyebrow>DESIGN STUDIO</Eyebrow>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          What would you like to <span className="grad-word">design</span>?
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-sm text-muted">
          Describe a graphic and get a finished, print-quality design — posters,
          social posts, flyers, covers, logos — rendered live and exported to PNG.
        </p>
      </div>

      {/* Composer */}
      <div className="rounded-2xl border border-line bg-surface2 p-4">
        {/* Format category tabs */}
        <div className="mb-3 flex flex-wrap gap-1.5">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => pickCategory(c)}
              aria-pressed={category === c}
              disabled={generating}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium transition disabled:opacity-60",
                category === c
                  ? "bg-ink text-surface"
                  : "border border-line bg-surface text-muted hover:border-accent/40 hover:text-ink",
              )}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Format chips within the active category */}
        <div className="mb-3 flex flex-wrap gap-2">
          {catFormats.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => !generating && setFormatId(f.id)}
              aria-pressed={formatId === f.id}
              disabled={generating}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition disabled:opacity-60",
                formatId === f.id
                  ? "border-accent/60 bg-accent/10 text-ink"
                  : "border-line bg-surface text-muted hover:border-accent/40 hover:text-ink",
              )}
            >
              <FormatGlyph width={f.width} height={f.height} active={formatId === f.id} />
              <span className="flex flex-col leading-tight">
                <span className="font-medium">{f.label}</span>
                <span className="text-[10px] text-muted">
                  {f.width}×{f.height}
                </span>
              </span>
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
          Describe your design
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
            placeholder="A bold poster for a summer rooftop jazz night — headline, date, venue, and a warm sunset palette…"
            rows={3}
            maxLength={4000}
            disabled={generating}
          />
        </label>

        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium text-ink">
            Design system
            <Select
              value={palette}
              onValueChange={(v) => setPalette(v as DesignPalette)}
              disabled={generating}
            >
              <SelectTrigger aria-label="Design system palette">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PALETTES.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="flex items-center gap-2">
                      <SwatchDots swatch={p.swatch} />
                      <span>{p.label}</span>
                      <span className="text-xs text-muted">— {p.description}</span>
                    </span>
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
                {statusLabel ?? "Designing…"}
              </>
            ) : (
              <>
                <Sparkles />
                Generate design
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
            <Loader2 className="size-3.5 animate-spin text-accent" />
            <span className="text-xs font-medium text-muted">
              {statusLabel ?? "Composing…"}
            </span>
            <span className="ml-auto rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
              {format.label} · {format.width}×{format.height}
            </span>
          </div>
          {previewHtml ? (
            <ScaledDesignFrame
              html={previewHtml}
              width={format.width}
              height={format.height}
              title="Live design preview"
              className="h-[52vh] w-full bg-surface3/40 p-6"
            />
          ) : (
            <div className="grid h-[52vh] place-items-center bg-surface3/40">
              <div className="flex flex-col items-center gap-2 text-muted">
                <Shapes className="size-6 animate-pulse text-accent" />
                <span className="text-xs">Sketching your design…</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Existing designs */}
      <div className="mt-10">
        <Eyebrow className="mb-3">Your designs</Eyebrow>
        {isInitialLoading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[4/5] rounded-xl" />
            ))}
          </div>
        ) : designs.length === 0 && !generating ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line py-14 text-center">
            <div className="grid size-12 place-items-center rounded-lg bg-ink text-surface">
              <Palette className="size-6" />
            </div>
            <p className="font-display text-lg font-semibold text-ink">No designs yet</p>
            <p className="max-w-xs text-sm text-muted">
              Describe something above — or start from an example below — to create
              your first design.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {designs.map((a, i) => (
              <DesignCard
                key={a.id}
                artifact={a}
                index={i}
                onOpen={() => navigate(`/tools/design/${a.id}`)}
                listPath={LIST_PATH}
              />
            ))}
          </div>
        )}
      </div>

      {/* Example prompts */}
      <DesignTemplateGallery onUse={useTemplate} />
    </div>
  );
}

// ── Format glyph (a tiny scaled rectangle showing the aspect ratio) ─────────

function FormatGlyph({
  width,
  height,
  active,
}: {
  width: number;
  height: number;
  active: boolean;
}) {
  const box = 18;
  const scale = box / Math.max(width, height);
  const w = Math.max(4, Math.round(width * scale));
  const h = Math.max(4, Math.round(height * scale));
  return (
    <span
      className="grid size-[18px] shrink-0 place-items-center"
      aria-hidden
    >
      <span
        className={cn(
          "rounded-[2px] border",
          active ? "border-accent bg-accent/30" : "border-muted/50 bg-muted/10",
        )}
        style={{ width: w, height: h }}
      />
    </span>
  );
}

function SwatchDots({ swatch }: { swatch: [string, string, string] }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
      {swatch.map((c, i) => (
        <span
          key={i}
          className="size-2.5 rounded-full ring-1 ring-black/10"
          style={{ background: c }}
        />
      ))}
    </span>
  );
}

// ── Existing-design card (static palette-tinted tile — the list summary has no
// html to render, so we sketch a cover keyed on the palette + aspect ratio). ──

function DesignCard({
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

  const format = getFormat(
    typeof artifact.meta?.format === "string" ? (artifact.meta.format as string) : null,
  );
  const palette = getPalette(
    typeof artifact.meta?.palette === "string" ? (artifact.meta.palette as string) : null,
  );
  const swatch = palette?.swatch ?? ["#6366f1", "#ec4899", "#f59e0b"];
  const ratio = format ? `${format.width} / ${format.height}` : "4 / 5";

  async function remove(e: React.MouseEvent) {
    e.stopPropagation();
    const ok = await confirm({
      title: "Delete design?",
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
        {/* Palette-tinted cover with the format's aspect ratio */}
        <div
          className="relative w-full overflow-hidden"
          style={{
            aspectRatio: ratio,
            maxHeight: 260,
            background: `linear-gradient(135deg, ${swatch[0]} 0%, ${swatch[2]} 120%)`,
          }}
        >
          <span
            className="absolute left-4 top-5 h-1.5 w-10 rounded-full"
            style={{ background: swatch[1] }}
          />
          <span
            className="absolute left-4 top-9 block h-2.5 w-24 rounded-full opacity-90"
            style={{ background: "rgba(255,255,255,0.85)" }}
          />
          <span
            className="absolute left-4 top-[52px] block h-2 w-16 rounded-full opacity-60"
            style={{ background: "rgba(255,255,255,0.6)" }}
          />
          <Shapes className="absolute bottom-3 right-3 size-5 text-white/60" />
          {artifact.parent_id && (
            <span className="absolute right-3 top-3 rounded-full bg-black/40 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur">
              revision
            </span>
          )}
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
            className="absolute bottom-3 left-3 grid size-7 place-items-center rounded-md bg-black/40 text-white opacity-0 backdrop-blur transition hover:bg-rose-500/80 group-hover:opacity-100"
            aria-label={`Delete ${artifact.title}`}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </span>
        </div>
        <div className="px-3 py-2.5">
          <p className="truncate text-sm font-medium text-ink group-hover:text-accent">
            {artifact.title || "Untitled design"}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
            {format && (
              <span className="truncate rounded-full border border-line bg-surface px-1.5 py-0.5 uppercase tracking-wide">
                {format.label}
              </span>
            )}
            <span className="ml-auto shrink-0">{timeAgo(artifact.created_at)}</span>
          </p>
        </div>
      </button>
    </motion.div>
  );
}

// ── Example-prompt gallery ──────────────────────────────────────────────────

function DesignTemplateGallery({ onUse }: { onUse: (t: DesignTemplate) => void }) {
  const [active, setActive] = useState<string>("All");
  const tabs = ["All", ...CATEGORIES];
  const templates =
    active === "All"
      ? DESIGN_TEMPLATES
      : DESIGN_TEMPLATES.filter((t) => t.category === active);

  return (
    <section className="mt-12">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Eyebrow>Start from an example</Eyebrow>
        <div className="flex flex-wrap gap-1.5">
          {tabs.map((c) => (
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
        {templates.map((t, i) => {
          const palette = getPalette(t.palette);
          const swatch = palette?.swatch ?? ["#6366f1", "#ec4899", "#f59e0b"];
          const format = getFormat(t.format);
          return (
            <motion.button
              key={t.id}
              type="button"
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: Math.min(i * 0.03, 0.24) }}
              onClick={() => onUse(t)}
              className="group flex flex-col overflow-hidden rounded-xl border border-line bg-surface2 p-2.5 text-left outline-none transition hover:border-accent/40 focus-visible:ring-2 focus-visible:ring-accent/50"
              aria-label={`Use example: ${t.title}`}
            >
              <div className="relative">
                <div
                  className="relative aspect-[16/10] w-full overflow-hidden rounded-lg"
                  style={{
                    background: `linear-gradient(135deg, ${swatch[0]} 0%, ${swatch[2]} 130%)`,
                  }}
                >
                  <span
                    className="absolute left-3 top-3 h-1.5 w-8 rounded-full"
                    style={{ background: swatch[1] }}
                  />
                  <span className="absolute left-3 top-6 block h-2 w-16 rounded-full bg-white/85" />
                  <span className="absolute left-3 top-9 block h-1.5 w-10 rounded-full bg-white/60" />
                </div>
                <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-gradient-to-t from-black/55 to-transparent px-2 py-2 text-[11px] font-semibold text-white opacity-0 transition group-hover:opacity-100">
                  Use example
                  <ArrowRight className="size-3 transition group-hover:translate-x-0.5" />
                </span>
              </div>
              <div className="mt-2 px-0.5 pb-0.5">
                <p className="truncate text-sm font-medium text-ink group-hover:text-accent">
                  {t.title}
                </p>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="shrink-0 rounded-full border border-line bg-surface px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                    {t.category}
                  </span>
                  <span className="truncate text-[11px] text-muted">
                    {format?.label ?? t.description}
                  </span>
                </div>
              </div>
            </motion.button>
          );
        })}
      </div>
    </section>
  );
}
