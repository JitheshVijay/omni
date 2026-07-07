// /tools/design/:artifactId: the Design Studio viewer. Loads a design
// artifact (kind=webpage, meta.subtype "design"; content {html, format,
// width, height}) and shows the graphic in a sandboxed iframe rendered at its
// exact pixel size, scaled with a CSS transform to fit the viewport. Toolbar:
// Export PNG (html-to-image over the #design-canvas node inside the iframe),
// Edit with AI (revise -> new artifact -> navigate), Export .html, Open in a
// new tab, Export to Drive, Delete. Load goes through useApi (StrictMode-safe).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toPng } from "html-to-image";
import {
  ArrowLeft,
  Check,
  Code2,
  Download,
  ExternalLink,
  HardDriveUpload,
  Image as ImageIcon,
  Loader2,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { useApi, authFetch, invalidateApi, invalidateApiPrefix } from "@/lib/use-api";
import { streamRevise } from "@/lib/generate";
import type { Artifact } from "@/lib/types";
import { getFormat } from "@/lib/design-formats";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { CodeBlock } from "@/components/CodeBlock";

const LIST_PATH = "/api/artifacts?kind=webpage&limit=50";

interface DesignContent {
  html?: unknown;
  format?: unknown;
  width?: unknown;
  height?: unknown;
}

function designOf(artifact: Artifact | undefined): {
  html: string;
  width: number;
  height: number;
  format: string;
} {
  const c = (artifact?.content ?? null) as DesignContent | null;
  const fmt = typeof c?.format === "string" ? c.format : "poster";
  const known = getFormat(fmt);
  const width = typeof c?.width === "number" ? c.width : known?.width ?? 1080;
  const height = typeof c?.height === "number" ? c.height : known?.height ?? 1350;
  return {
    html: typeof c?.html === "string" ? c.html : "",
    width,
    height,
    format: fmt,
  };
}

function safeName(title: string, ext: string): string {
  const base = (title || "design").slice(0, 60).replace(/[^\w\s-]/g, "").trim();
  return `${base || "design"}.${ext}`;
}

export default function DesignViewPage() {
  const { artifactId } = useParams<{ artifactId: string }>();
  const navigate = useNavigate();
  const confirm = useConfirm();

  const { data: artifact, isInitialLoading, error } = useApi<Artifact>(
    artifactId ? `/api/artifacts/${artifactId}` : null,
  );
  const { html, width, height, format } = designOf(artifact);
  const formatLabel = getFormat(format)?.label ?? format;

  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [instruction, setInstruction] = useState("");
  const [revising, setRevising] = useState(false);
  const [reviseStatus, setReviseStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [exported, setExported] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Reset per-artifact UI when navigating between designs (revise swaps the id).
  const lastIdRef = useRef<string | null>(null);
  if (artifactId && lastIdRef.current !== artifactId) {
    lastIdRef.current = artifactId;
    if (exported) setExported(false);
    if (instruction) setInstruction("");
    if (actionError) setActionError(null);
  }

  // Fit the fixed-size design canvas into the available stage, leaving a margin.
  const fit = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !width || !height) return;
    const pad = 48;
    const s = Math.min(
      (stage.clientWidth - pad) / width,
      (stage.clientHeight - pad) / height,
      1,
    );
    setScale(s > 0 ? s : 0.1);
  }, [width, height]);

  useLayoutEffect(() => {
    fit();
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [fit, tab]);

  async function exportPng() {
    if (busy) return;
    setBusy("png");
    setActionError(null);
    try {
      const doc = iframeRef.current?.contentDocument;
      const node =
        (doc?.getElementById("design-canvas") as HTMLElement | null) ??
        (doc?.body as HTMLElement | null);
      if (!node) throw new Error("Preview not ready. Try again in a moment.");
      const dataUrl = await toPng(node, {
        width,
        height,
        pixelRatio: 2,
        cacheBust: true,
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = safeName(artifact?.title ?? "design", "png");
      a.click();
    } catch (err) {
      setActionError(
        err instanceof Error
          ? `PNG export failed (${err.message}). You can Export .html instead.`
          : "PNG export failed.",
      );
    } finally {
      setBusy(null);
    }
  }

  function downloadHtml() {
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = safeName(artifact?.title ?? "design", "html");
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function openInNewTab() {
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function exportToDrive() {
    if (!artifactId || busy) return;
    setBusy("drive");
    setActionError(null);
    try {
      await authFetch(`/api/artifacts/${artifactId}/export-to-drive`, { method: "POST" });
      setExported(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Export to Drive failed.");
    } finally {
      setBusy(null);
    }
  }

  async function del() {
    if (!artifactId) return;
    const ok = await confirm({
      title: "Delete this design?",
      message: "This can't be undone.",
      danger: true,
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await authFetch(`/api/artifacts/${artifactId}`, { method: "DELETE" });
      void invalidateApi(LIST_PATH);
      void invalidateApiPrefix("/api/artifacts");
      navigate("/tools/design");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Delete failed.");
      setBusy(null);
    }
  }

  async function revise() {
    const trimmed = instruction.trim();
    if (!artifactId || !trimmed || revising) return;
    setRevising(true);
    setActionError(null);
    setReviseStatus("Starting…");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamRevise({
        artifactId,
        instruction: trimmed,
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === "status") setReviseStatus(e.label);
          else if (e.type === "artifact") {
            void invalidateApi(LIST_PATH);
            void invalidateApiPrefix("/api/artifacts");
            setInstruction("");
            navigate(`/tools/design/${e.artifact.id}`);
          } else if (e.type === "error") setActionError(e.message);
        },
      });
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setActionError(err instanceof Error ? err.message : "Edit failed.");
      }
    } finally {
      setRevising(false);
      setReviseStatus(null);
    }
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <ImageIcon className="size-10 text-muted/50" />
        <p className="font-display text-lg font-semibold text-ink">Couldn't load this design</p>
        <Button variant="secondary" onClick={() => navigate("/tools/design")}>
          Back to Design Studio
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3 md:px-6">
        <button
          onClick={() => navigate("/tools/design")}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface3/60 hover:text-ink"
          aria-label="Back"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          {isInitialLoading ? (
            <Skeleton className="h-5 w-48" />
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate font-display text-base font-semibold text-ink">
                {artifact?.title || "Design"}
              </h1>
              <span className="shrink-0 rounded-full border border-line bg-surface2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                {formatLabel}
              </span>
              <span className="shrink-0 text-xs text-muted">
                {width}×{height}
                {artifact?.created_at ? ` · ${timeAgo(artifact.created_at)}` : ""}
              </span>
            </div>
          )}
        </div>

        {/* Preview / Code tabs */}
        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-line bg-surface2 p-0.5">
          {(["preview", "code"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium capitalize transition",
                tab === t ? "bg-ink text-surface" : "text-muted hover:text-ink",
              )}
            >
              {t === "preview" ? <ImageIcon className="size-3.5" /> : <Code2 className="size-3.5" />}
              {t}
            </button>
          ))}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" onClick={exportPng} disabled={!!busy || !html}>
            {busy === "png" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            PNG
          </Button>
          <Button size="sm" variant="secondary" onClick={downloadHtml} disabled={!html}>
            <Download className="size-4" />
            .html
          </Button>
          <Button size="sm" variant="secondary" onClick={openInNewTab} disabled={!html}>
            <ExternalLink className="size-4" />
            Open
          </Button>
          <Button size="sm" variant="secondary" onClick={exportToDrive} disabled={!!busy}>
            {exported ? (
              <Check className="size-4 text-emerald-400" />
            ) : busy === "drive" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <HardDriveUpload className="size-4" />
            )}
            Drive
          </Button>
          <Button size="sm" variant="ghost" onClick={del} disabled={!!busy} aria-label="Delete">
            <Trash2 className="size-4 text-rose-400" />
          </Button>
        </div>
      </header>

      {/* Stage */}
      {tab === "preview" ? (
        <div
          ref={stageRef}
          className="grid min-h-0 flex-1 place-items-center overflow-hidden bg-[repeating-conic-gradient(rgb(var(--color-surface2))_0_25%,transparent_0_50%)] bg-[length:24px_24px] p-6"
        >
          {isInitialLoading ? (
            <Skeleton className="h-[70%] w-[40%] rounded-xl" />
          ) : (
            <div
              className="shrink-0 overflow-hidden rounded-xl border border-line bg-white"
              style={{
                width: width * scale,
                height: height * scale,
              }}
            >
              <iframe
                ref={iframeRef}
                key={artifactId}
                title={artifact?.title || "Design preview"}
                srcDoc={html}
                // allow-same-origin so PNG export can read the canvas node from
                // the (self-contained) document; safe for a local single-user tool.
                sandbox="allow-scripts allow-same-origin"
                style={{
                  width,
                  height,
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                  border: "0",
                }}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto scrollbar-thin p-4">
          <CodeBlock code={html} lang="html" />
        </div>
      )}

      {/* Edit-with-AI bar */}
      <div className="shrink-0 border-t border-line bg-surface px-4 py-3 md:px-6">
        {actionError && <p className="mb-2 text-xs text-rose-400">{actionError}</p>}
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <div className="relative flex-1">
            <WandSparkles className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void revise();
                }
              }}
              disabled={revising}
              placeholder={
                revising
                  ? reviseStatus ?? "Redesigning…"
                  : 'Edit with AI, e.g. "warmer palette" or "make the headline bigger"'
              }
              className="pl-9"
            />
          </div>
          <Button onClick={() => void revise()} disabled={revising || !instruction.trim()}>
            {revising ? <Loader2 className="size-4 animate-spin" /> : <WandSparkles className="size-4" />}
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}
