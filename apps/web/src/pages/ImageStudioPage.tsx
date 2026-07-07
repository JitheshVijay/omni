// /tools/images — Image Studio. Left: the generation form (prompt + aspect
// ratio); right: a gallery of every kind=image artifact. While a generation
// streams, the gallery's first tile is a shimmer placeholder narrated by the
// generator's status labels. Clicking any image opens a detail dialog with
// the prompt, lineage (parent/children resolved client-side from the list),
// and actions: Edit with AI (revise), Download, Export to Drive, Delete.

import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  ArrowLeft,
  Check,
  Download,
  GitBranch,
  HardDriveUpload,
  Images,
  Loader2,
  Sparkles,
  Trash2,
  WandSparkles,
} from "lucide-react";
import {
  useApi,
  authFetch,
  authFetchRaw,
  invalidateApi,
  invalidateApiPrefix,
} from "@/lib/use-api";
import { parseApiError } from "@/lib/api-error";
import { streamGenerate, streamRevise } from "@/lib/generate";
import { artifactBlobUrl } from "@/components/tools/ArtifactCard";
import type { ArtifactSummary } from "@/lib/types";
import { cn, timeAgo, prettyModel } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TemplateGallery } from "@/components/tools/TemplateGallery";
import { GeneratorSkillsStrip } from "@/components/skills/GeneratorSkillsStrip";
import { Eyebrow } from "@/components/brand/Eyebrow";
import type { GenTemplate } from "@/lib/templates";

const LIST_PATH = "/api/artifacts?kind=image&limit=50";

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
type AspectRatio = (typeof ASPECT_RATIOS)[number];

// "16:9" -> CSS aspect-ratio value.
function aspectToCss(ratio: string | undefined): string {
  if (typeof ratio === "string" && /^\d+:\d+$/.test(ratio)) {
    return ratio.replace(":", " / ");
  }
  return "1 / 1";
}

interface ImageStudioNavState {
  openId?: string;
}

export default function ImageStudioPage() {
  const location = useLocation();
  const navigate = useNavigate();

  const { data, isInitialLoading } = useApi<{ artifacts: ArtifactSummary[] }>(LIST_PATH);
  const images = data?.artifacts ?? [];

  // ── Generation form ────────────────────────────────────────────────────
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<AspectRatio>("1:1");
  const [generating, setGenerating] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const [selected, setSelected] = useState<ArtifactSummary | null>(null);

  // Template → prefill the form (prompt + aspect ratio) and focus it so the
  // user can tweak before generating (Genspark "Add & Use").
  function useTemplate(t: GenTemplate) {
    if (generating) return;
    setPrompt(t.prompt);
    const ar = t.extra?.aspect_ratio;
    if (ar && (ASPECT_RATIOS as readonly string[]).includes(ar)) {
      setAspect(ar as AspectRatio);
    }
    setGenError(null);
    requestAnimationFrame(() => {
      promptRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      promptRef.current?.focus();
    });
  }

  // Deep-link from Tools/Library: open a specific artifact once the list is
  // in. Router state is cleared immediately so back/refresh doesn't re-open.
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null);
  useEffect(() => {
    const openId = (location.state as ImageStudioNavState | null)?.openId;
    if (!openId) return;
    navigate(location.pathname, { replace: true, state: null });
    setPendingOpenId(openId);
  }, [location.state]);
  useEffect(() => {
    if (!pendingOpenId || images.length === 0) return;
    const target = images.find((a) => a.id === pendingOpenId);
    if (target) {
      setSelected(target);
      setPendingOpenId(null);
    }
  }, [pendingOpenId, images]);

  // Abort a live generation when leaving the page.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Skill → seed the prompt (aspect ratio stays as configured) and focus the
  // form, mirroring the template "Add & Use".
  function seedPrompt(seeded: string) {
    if (generating) return;
    setPrompt(seeded);
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
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamGenerate({
        name: "image",
        body: { prompt: trimmed, aspect_ratio: aspect },
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === "status") setStatusLabel(e.label);
          else if (e.type === "artifact") {
            void invalidateApi(LIST_PATH);
            void invalidateApiPrefix("/api/artifacts");
            setSelected(e.artifact);
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
        <Eyebrow>IMAGE STUDIO</Eyebrow>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Create with <span className="grad-word">Image Studio</span>
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-sm text-muted">
          Describe it, generate it, then refine it with follow-up edits.
        </p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[340px_1fr]">
        {/* Generation form */}
        <div className="rounded-2xl border border-line bg-surface2 p-4 lg:sticky lg:top-0">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Prompt
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
              placeholder="A watercolor fox reading a book under a lantern…"
              rows={4}
              maxLength={2000}
              disabled={generating}
            />
          </label>
          <label className="mt-3 flex flex-col gap-1.5 text-sm font-medium text-ink">
            Aspect ratio
            <Select
              value={aspect}
              onValueChange={(v) => setAspect(v as AspectRatio)}
              disabled={generating}
            >
              <SelectTrigger aria-label="Aspect ratio">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASPECT_RATIOS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                    <span className="ml-1.5 text-muted">
                      {r === "1:1"
                        ? "square"
                        : r === "16:9"
                          ? "landscape"
                          : r === "9:16"
                            ? "portrait"
                            : r === "4:3"
                              ? "classic"
                              : "tall"}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {genError && (
            <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{genError}</p>
          )}
          <Button
            className="mt-4 w-full"
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
                Generate
              </>
            )}
          </Button>
        </div>

        {/* Gallery */}
        <div>
          {isInitialLoading ? (
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="aspect-square rounded-xl" />
              ))}
            </div>
          ) : images.length === 0 && !generating ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line py-16 text-center">
              <div className="grid size-12 place-items-center rounded-lg bg-ink text-surface">
                <Images className="size-6" />
              </div>
              <p className="font-display text-lg font-semibold text-ink">
                No images yet
              </p>
              <p className="max-w-xs text-sm text-muted">
                Your generations appear here — try a prompt on the left to make
                your first one.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
              {generating && (
                <div
                  className="img-shimmer relative overflow-hidden rounded-xl border border-accent/30"
                  style={{ aspectRatio: aspectToCss(aspect) }}
                >
                  <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/50 to-transparent p-2.5">
                    <Loader2 className="size-3.5 animate-spin text-white" />
                    <span className="truncate text-xs font-medium text-white">
                      {statusLabel ?? "Generating…"}
                    </span>
                  </div>
                </div>
              )}
              {images.map((a, i) => (
                <motion.button
                  key={a.id}
                  type="button"
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.2, delay: Math.min(i * 0.03, 0.25) }}
                  onClick={() => setSelected(a)}
                  className="group relative overflow-hidden rounded-xl border border-line bg-ink/5 outline-none transition hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/50"
                  style={{
                    aspectRatio: aspectToCss(
                      typeof a.meta?.aspect_ratio === "string"
                        ? (a.meta.aspect_ratio as string)
                        : undefined,
                    ),
                  }}
                  aria-label={`Open ${a.title}`}
                >
                  <img
                    src={artifactBlobUrl(a.id)}
                    alt={a.title}
                    loading="lazy"
                    className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.04]"
                  />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-1 bg-gradient-to-t from-black/60 to-transparent p-2.5 opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100">
                    <p className="truncate text-xs font-medium text-white">{a.title}</p>
                  </div>
                  {a.parent_id && (
                    <span className="absolute right-2 top-2 rounded-full bg-black/50 p-1 text-white backdrop-blur">
                      <GitBranch className="size-3" />
                    </span>
                  )}
                </motion.button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Skills that target images — seed the prompt above */}
      <GeneratorSkillsStrip output="image" onUse={seedPrompt} />

      {/* Template gallery */}
      <TemplateGallery kind="image" onUse={useTemplate} />

      <ImageDetailDialog
        artifact={selected}
        all={images}
        onClose={() => setSelected(null)}
        onSelect={setSelected}
      />
    </div>
  );
}

// ── Detail dialog ────────────────────────────────────────────────────────

function ImageDetailDialog({
  artifact,
  all,
  onClose,
  onSelect,
}: {
  artifact: ArtifactSummary | null;
  all: ArtifactSummary[];
  onClose: () => void;
  onSelect: (a: ArtifactSummary) => void;
}) {
  const confirm = useConfirm();
  const [instruction, setInstruction] = useState("");
  const [revising, setRevising] = useState(false);
  const [reviseStatus, setReviseStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [exported, setExported] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Reset per artifact (render-phase state seeding, same pattern as the
  // Drive RenameDialog).
  const lastIdRef = useRef<string | null>(null);
  if (artifact && lastIdRef.current !== artifact.id) {
    lastIdRef.current = artifact.id;
    setInstruction("");
    setError(null);
    setExported(false);
  }
  if (!artifact && lastIdRef.current) lastIdRef.current = null;

  useEffect(() => () => abortRef.current?.abort(), []);

  if (!artifact) return null;

  const prompt =
    typeof artifact.meta?.prompt === "string" ? (artifact.meta.prompt as string) : null;
  const model =
    typeof artifact.meta?.model === "string" ? (artifact.meta.model as string) : null;
  const ratio =
    typeof artifact.meta?.aspect_ratio === "string"
      ? (artifact.meta.aspect_ratio as string)
      : null;
  const parent = artifact.parent_id
    ? all.find((a) => a.id === artifact.parent_id) ?? null
    : null;
  const children = all.filter((a) => a.parent_id === artifact.id);

  async function revise() {
    if (!artifact || !instruction.trim() || revising) return;
    setRevising(true);
    setError(null);
    setReviseStatus("Starting…");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamRevise({
        artifactId: artifact.id,
        instruction: instruction.trim(),
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === "status") setReviseStatus(e.label);
          else if (e.type === "artifact") {
            void invalidateApi(LIST_PATH);
            void invalidateApiPrefix("/api/artifacts");
            setInstruction("");
            onSelect(e.artifact);
          } else if (e.type === "error") setError(e.message);
        },
      });
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setError(err instanceof Error ? err.message : "Edit failed.");
      }
    } finally {
      setRevising(false);
      setReviseStatus(null);
    }
  }

  async function download() {
    if (!artifact) return;
    setBusyAction("download");
    setError(null);
    try {
      const res = await authFetchRaw(`/api/artifacts/${artifact.id}/blob`);
      if (!res.ok) throw new Error((await parseApiError(res)).message);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(artifact.title || "image").slice(0, 60).replace(/[^\w\s-]/g, "").trim() || "image"}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function exportToDrive() {
    if (!artifact) return;
    setBusyAction("export");
    setError(null);
    try {
      await authFetch(`/api/artifacts/${artifact.id}/export-to-drive`, {
        method: "POST",
      });
      void invalidateApiPrefix("/api/drive/files");
      setExported(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function remove() {
    if (!artifact) return;
    const ok = await confirm({
      title: "Delete image?",
      message: <>“{artifact.title}” will be permanently removed. This can't be undone.</>,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusyAction("delete");
    try {
      await authFetch(`/api/artifacts/${artifact.id}`, { method: "DELETE" });
      void invalidateApi(LIST_PATH);
      void invalidateApiPrefix("/api/artifacts");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <Dialog open={!!artifact} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl gap-3 overflow-y-auto scrollbar-thin max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="pr-8 text-base leading-snug">
            {artifact.title || "Untitled image"}
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-hidden rounded-xl border border-line bg-ink/5">
          <img
            key={artifact.id}
            src={artifactBlobUrl(artifact.id)}
            alt={artifact.title}
            className="max-h-[55vh] w-full object-contain"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          {ratio && (
            <span className="rounded-full border border-line bg-surface px-2 py-0.5">
              {ratio}
            </span>
          )}
          {model && (
            <span className="rounded-full border border-line bg-surface px-2 py-0.5">
              {prettyModel(model)}
            </span>
          )}
          <span className="rounded-full border border-line bg-surface px-2 py-0.5">
            {timeAgo(artifact.created_at)}
          </span>
        </div>

        {prompt && (
          <p className="rounded-lg border border-line bg-surface px-3 py-2 text-xs leading-relaxed text-muted">
            {prompt}
          </p>
        )}

        {/* Lineage */}
        {(parent || children.length > 0) && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <GitBranch className="size-3.5 shrink-0" />
            {parent && (
              <button
                type="button"
                onClick={() => onSelect(parent)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 transition hover:border-accent/40 hover:text-accent"
              >
                <img
                  src={artifactBlobUrl(parent.id)}
                  alt=""
                  className="size-5 rounded object-cover"
                />
                Edited from “{parent.title.slice(0, 30)}”
              </button>
            )}
            {children.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelect(c)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 transition hover:border-accent/40 hover:text-accent"
                title={c.title}
              >
                <img
                  src={artifactBlobUrl(c.id)}
                  alt=""
                  className="size-5 rounded object-cover"
                />
                Edit · {timeAgo(c.created_at)}
              </button>
            ))}
          </div>
        )}

        {/* Edit with AI */}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void revise();
          }}
        >
          <div className="relative flex-1">
            <WandSparkles className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-accent" />
            <Input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Edit with AI — e.g. “make it nighttime, add fireflies”"
              className="pl-8"
              maxLength={2000}
              disabled={revising}
            />
          </div>
          <Button type="submit" disabled={!instruction.trim() || revising}>
            {revising ? (
              <>
                <Loader2 className="animate-spin" />
                {reviseStatus ?? "Editing…"}
              </>
            ) : (
              "Apply"
            )}
          </Button>
        </form>

        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void download()}
            disabled={busyAction !== null}
          >
            {busyAction === "download" ? <Loader2 className="animate-spin" /> : <Download />}
            Download
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void exportToDrive()}
            disabled={busyAction !== null || exported}
          >
            {busyAction === "export" ? (
              <Loader2 className="animate-spin" />
            ) : exported ? (
              <Check className="text-emerald-500" />
            ) : (
              <HardDriveUpload />
            )}
            {exported ? "In Drive" : "Export to Drive"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("ml-auto text-rose-600 hover:text-rose-600 dark:text-rose-400")}
            onClick={() => void remove()}
            disabled={busyAction !== null}
          >
            {busyAction === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
