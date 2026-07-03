// /tools/docs/new AND /tools/docs/:id — one component, two modes.
//
// /new: reads {prompt, hub_id, length} from router state (handed off by
// DocsListPage) and immediately starts streamGenerate("doc"). Streamed
// markdown accumulates in a ref and is re-parsed into the (read-only)
// BlockNote editor every ~500ms or on a double-newline boundary. On the
// terminal artifact event the URL is swapped in place via
// history.replaceState (no remount), the artifact is fetched, and the final
// full parse — WITH [[cite:..]] → citation-pill conversion — unlocks editing.
// The initial stream start is guarded against StrictMode's double mount with
// the cancellable setTimeout(0) pattern from ChatThreadPage.
//
// /:id: loads the artifact and renders saved blocks (falling back to the
// markdown) plus the sources side panel; citation pill clicks arrive as
// "omni:citation-click" CustomEvents and scroll/flash the source card.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Download,
  FileX2,
  HardDriveUpload,
  Loader2,
  MoreHorizontal,
  Printer,
  Quote,
  Save,
  Trash2,
  Volume2,
  WandSparkles,
} from "lucide-react";
import { authFetch, invalidateApiPrefix } from "@/lib/use-api";
import { streamGenerate, streamRevise } from "@/lib/generate";
import { useReadAloud, MiniPlayer, VOICE_UNCONFIGURED_HINT } from "@/lib/audio-player";
import {
  BlockNoteDoc,
  CITATION_CLICK_EVENT,
  type BlockNoteDocHandle,
  type CitationClickDetail,
} from "@/components/tools/BlockNoteDoc";
import type { Artifact, ArtifactSummary, DocContent, DocSource } from "@/lib/types";
import type { DocGenNavState } from "@/pages/DocsListPage";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Phase = "generating" | "loading" | "ready" | "error";

const PARSE_INTERVAL_MS = 500;

export default function DocEditorPage() {
  const { artifactId: routeId } = useParams<{ artifactId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const isNew = !routeId;

  const [artifactId, setArtifactId] = useState<string | null>(routeId ?? null);
  const [phase, setPhase] = useState<Phase>(isNew ? "generating" : "loading");
  const [statusLabel, setStatusLabel] = useState<string | null>(
    isNew ? "Starting…" : null,
  );
  const [pageError, setPageError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [sources, setSources] = useState<DocSource[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exported, setExported] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState<number | null>(null);

  const docRef = useRef<BlockNoteDocHandle>(null);
  const abortRef = useRef<AbortController | null>(null);
  const savedTitleRef = useRef("");
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readAloud = useReadAloud(() => docRef.current?.getMarkdown() ?? null);

  // ── Streaming markdown → throttled editor re-parse ─────────────────────
  const accRef = useRef("");
  const lastParseRef = useRef(0);
  const parseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushParse = useCallback(() => {
    if (parseTimerRef.current) {
      clearTimeout(parseTimerRef.current);
      parseTimerRef.current = null;
    }
    lastParseRef.current = Date.now();
    if (accRef.current) docRef.current?.setMarkdown(accRef.current);
  }, []);

  const pushDelta = useCallback(
    (text: string) => {
      accRef.current += text;
      // Re-parse on paragraph boundaries or every PARSE_INTERVAL_MS,
      // whichever comes first; a trailing timer catches the final chunk.
      if (text.includes("\n\n") || Date.now() - lastParseRef.current > PARSE_INTERVAL_MS) {
        flushParse();
      } else if (!parseTimerRef.current) {
        parseTimerRef.current = setTimeout(flushParse, PARSE_INTERVAL_MS);
      }
    },
    [flushParse],
  );

  // ── Shared artifact loader ──────────────────────────────────────────────
  const applyArtifact = useCallback((art: Artifact) => {
    const content = (art.content ?? {}) as Partial<DocContent>;
    setTitle(art.title ?? "");
    savedTitleRef.current = art.title ?? "";
    const srcs = Array.isArray(content.sources) ? content.sources : [];
    setSources(srcs);
    if (Array.isArray(content.blocks) && content.blocks.length > 0) {
      docRef.current?.setBlocks(content.blocks);
    } else {
      // Pass sources explicitly — the setSources state update above hasn't
      // rendered into the editor's props yet.
      docRef.current?.setMarkdown(content.markdown ?? "", srcs);
    }
    setDirty(false);
    setPhase("ready");
  }, []);

  // ── /new mode: start the generation exactly once ────────────────────────
  // Deferred one tick + cancelled on cleanup: StrictMode's throwaway mount
  // never fires the timer, the surviving mount starts one stream. Router
  // state is cleared first so refresh/back never regenerates.
  useEffect(() => {
    if (!isNew) return;
    const state = location.state as DocGenNavState | null;
    if (!state?.prompt) {
      navigate("/tools/docs", { replace: true });
      return;
    }
    const timer = setTimeout(() => {
      navigate(location.pathname, { replace: true, state: null });
      void runGeneration(state);
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runGeneration(state: DocGenNavState) {
    setPhase("generating");
    setTitle(state.prompt.slice(0, 80));
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamGenerate({
        name: "doc",
        body: {
          prompt: state.prompt,
          length: state.length,
          ...(state.hub_id ? { hub_id: state.hub_id } : {}),
        },
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === "status") setStatusLabel(e.label);
          else if (e.type === "delta" && e.channel === "markdown") {
            pushDelta(String(e.data ?? ""));
          } else if (e.type === "artifact") {
            void finishGeneration(e.artifact);
          } else if (e.type === "error") {
            setPageError(e.message);
            setPhase("error");
          }
        },
      });
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setPageError(err instanceof Error ? err.message : "Generation failed.");
        setPhase("error");
      }
    } finally {
      setStatusLabel(null);
    }
  }

  async function finishGeneration(artifact: ArtifactSummary) {
    flushParse();
    // Swap the URL in place — no router navigation, so the editor (and the
    // streamed content already in it) never remounts.
    window.history.replaceState(null, "", `/tools/docs/${artifact.id}`);
    setArtifactId(artifact.id);
    void invalidateApiPrefix("/api/artifacts");
    try {
      const art = await authFetch<Artifact>(`/api/artifacts/${artifact.id}`);
      applyArtifact(art);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Could not load the document.");
      setPhase("error");
    }
  }

  // ── /:id mode (and revise navigations): load on param change ───────────
  useEffect(() => {
    if (!routeId) return;
    let cancelled = false;
    setPhase("loading");
    setPageError(null);
    setArtifactId(routeId);
    (async () => {
      try {
        const art = await authFetch<Artifact>(`/api/artifacts/${routeId}`);
        if (cancelled) return;
        applyArtifact(art);
      } catch (err) {
        if (cancelled) return;
        setPageError(err instanceof Error ? err.message : "Could not load the document.");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routeId, applyArtifact]);

  // Abort a live generation + timers when leaving the page.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (parseTimerRef.current) clearTimeout(parseTimerRef.current);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    },
    [],
  );

  // ── Citation pill clicks → scroll/flash the source card ────────────────
  useEffect(() => {
    function onCite(e: Event) {
      const detail = (e as CustomEvent<CitationClickDetail>).detail;
      const idx = Number(detail?.source_idx);
      if (!Number.isFinite(idx)) return;
      setHighlightIdx(idx);
      document
        .getElementById(`doc-source-${idx}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => setHighlightIdx(null), 2000);
    }
    window.addEventListener(CITATION_CLICK_EVENT, onCite);
    return () => window.removeEventListener(CITATION_CLICK_EVENT, onCite);
  }, []);

  // ── Toolbar actions ─────────────────────────────────────────────────────
  async function saveTitle() {
    const t = title.trim() || "Untitled document";
    if (!artifactId || t === savedTitleRef.current) return;
    try {
      await authFetch(`/api/artifacts/${artifactId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: t }),
      });
      savedTitleRef.current = t;
      void invalidateApiPrefix("/api/artifacts");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Rename failed.");
    }
  }

  async function saveContent() {
    const handle = docRef.current;
    if (!artifactId || !handle || saving) return;
    setSaving(true);
    setActionError(null);
    try {
      await authFetch(`/api/artifacts/${artifactId}`, {
        method: "PATCH",
        body: JSON.stringify({
          content: {
            markdown: handle.getMarkdown(),
            blocks: handle.getBlocks(),
            sources,
          },
        }),
      });
      setDirty(false);
      void invalidateApiPrefix("/api/artifacts");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  function exportMarkdown() {
    const md = docRef.current?.getMarkdown() ?? "";
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const base = (title || "document").replace(/[^\w\s-]/g, "").trim().slice(0, 60);
    a.download = `${base || "document"}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function exportToDrive() {
    if (!artifactId) return;
    setActionError(null);
    try {
      await authFetch(`/api/artifacts/${artifactId}/export-to-drive`, {
        method: "POST",
      });
      void invalidateApiPrefix("/api/drive/files");
      setExported(true);
      setTimeout(() => setExported(false), 2500);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Export failed.");
    }
  }

  async function removeDoc() {
    if (!artifactId) return;
    const ok = await confirm({
      title: "Delete document?",
      message: <>“{title || "Untitled"}” will be permanently removed.</>,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await authFetch(`/api/artifacts/${artifactId}`, { method: "DELETE" });
      void invalidateApiPrefix("/api/artifacts");
      navigate("/tools/docs");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  // ── Error phase ─────────────────────────────────────────────────────────
  if (phase === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <FileX2 className="size-10 text-muted/50" />
        <p className="font-display text-lg font-semibold text-ink">
          Couldn't {isNew && !artifactId ? "generate" : "load"} this document
        </p>
        <p className="max-w-sm text-sm text-muted">{pageError}</p>
        <Button variant="secondary" asChild>
          <Link to="/tools/docs">Back to Docs</Link>
        </Button>
      </div>
    );
  }

  const generating = phase === "generating";
  const listenDisabled = readAloud.configured === false;
  const listenButton = (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => void readAloud.play()}
      disabled={phase !== "ready" || listenDisabled || readAloud.status === "loading"}
      aria-label="Read this document aloud"
    >
      {readAloud.status === "loading" ? (
        <Loader2 className="animate-spin" />
      ) : (
        <Volume2 />
      )}
      Listen
    </Button>
  );

  return (
    <div className="flex h-screen min-h-0 flex-col print:block print:h-auto">
      {/* Toolbar */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5 md:px-6 print:hidden">
        <Button variant="ghost" size="iconSm" asChild aria-label="Back to Docs">
          <Link to="/tools/docs">
            <ArrowLeft />
          </Link>
        </Button>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          disabled={phase !== "ready"}
          placeholder="Untitled document"
          aria-label="Document title"
          className="min-w-0 flex-1 truncate rounded-md bg-transparent px-2 py-1 font-display text-sm font-semibold text-ink outline-none transition placeholder:text-muted hover:bg-ink/[0.03] focus:bg-ink/[0.04] focus:ring-2 focus:ring-accent/30 md:text-base"
        />

        {generating && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent">
            <Loader2 className="size-3 animate-spin" />
            {statusLabel ?? "Writing…"}
          </span>
        )}

        {dirty && !generating && (
          <span
            className="inline-flex items-center gap-1.5 text-[11px] text-muted"
            title="You have unsaved changes"
          >
            <span className="size-1.5 rounded-full bg-amber-500" />
            Unsaved
          </span>
        )}

        <Button
          size="sm"
          variant={dirty ? "default" : "secondary"}
          onClick={() => void saveContent()}
          disabled={phase !== "ready" || saving || !dirty}
        >
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          Save
        </Button>

        {listenDisabled ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">{listenButton}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{VOICE_UNCONFIGURED_HINT}</TooltipContent>
          </Tooltip>
        ) : (
          listenButton
        )}

        <Button
          size="sm"
          variant="secondary"
          onClick={() => setEditOpen(true)}
          disabled={phase !== "ready"}
        >
          <WandSparkles />
          Edit with AI
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="iconSm" variant="ghost" aria-label="More actions">
              {exported ? <Check className="text-emerald-500" /> : <MoreHorizontal />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={exportMarkdown} disabled={phase !== "ready"}>
              <Download />
              Export .md
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTimeout(() => window.print(), 50)}
              disabled={phase !== "ready"}
            >
              <Printer />
              Print / PDF
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void exportToDrive()}
              disabled={phase !== "ready"}
            >
              <HardDriveUpload />
              Export to Drive
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-rose-600 focus:text-rose-600 dark:text-rose-400"
              onSelect={() => void removeDoc()}
              disabled={!artifactId}
            >
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {actionError && (
        <p className="border-b border-rose-500/20 bg-rose-500/[0.06] px-6 py-1.5 text-xs text-rose-600 dark:text-rose-400 print:hidden">
          {actionError}
        </p>
      )}

      {/* Body: editor column + sources panel */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin print:overflow-visible">
        <div
          className={cn(
            "mx-auto grid w-full gap-8 px-4 py-8 md:px-8 print:block print:max-w-none print:p-0",
            sources.length > 0 ? "max-w-6xl lg:grid-cols-[minmax(0,1fr)_280px]" : "max-w-3xl",
          )}
        >
          <div className="doc-print-root min-w-0">
            {phase === "loading" && (
              <div className="space-y-3 py-2">
                <Skeleton className="h-8 w-2/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="mt-6 h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            )}
            <div className={cn(phase === "loading" && "hidden")}>
              <BlockNoteDoc
                editorRef={docRef}
                sources={sources}
                editable={phase === "ready"}
                onDirtyChange={setDirty}
              />
            </div>
          </div>

          {sources.length > 0 && (
            <aside className="print:hidden lg:sticky lg:top-8 lg:self-start">
              <h2 className="mb-2 flex items-center gap-1.5 font-display text-xs font-semibold uppercase tracking-wider text-muted">
                <Quote className="size-3.5" />
                Sources
              </h2>
              <div className="space-y-2">
                {sources.map((s) => (
                  <SourceCard key={s.idx} source={s} highlighted={highlightIdx === s.idx} />
                ))}
              </div>
            </aside>
          )}
        </div>
      </div>

      <EditWithAiDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        artifactId={artifactId}
        onDone={(a) => {
          setEditOpen(false);
          navigate(`/tools/docs/${a.id}`);
        }}
      />

      <MiniPlayer controls={readAloud} label={title || "Document"} />
    </div>
  );
}

// ── Source card ──────────────────────────────────────────────────────────

function SourceCard({ source, highlighted }: { source: DocSource; highlighted: boolean }) {
  return (
    <div
      id={`doc-source-${source.idx}`}
      className={cn(
        "rounded-xl border bg-surface2 p-3 transition-all duration-300",
        highlighted
          ? "border-accent shadow-md ring-2 ring-accent/30"
          : "border-line shadow-sm",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="grid size-5 shrink-0 place-items-center rounded-md bg-accent/10 font-mono text-[10px] font-semibold text-accent">
          {source.idx}
        </span>
        {source.file_id ? (
          <Link
            to="/drive"
            className="min-w-0 truncate text-xs font-medium text-ink transition hover:text-accent"
            title={`${source.label} — open Drive`}
          >
            {source.label}
          </Link>
        ) : (
          <span className="min-w-0 truncate text-xs font-medium text-ink">
            {source.label}
          </span>
        )}
      </div>
      {source.snippet && (
        <p className="mt-1.5 line-clamp-4 text-[11px] leading-relaxed text-muted">
          {source.snippet}
        </p>
      )}
    </div>
  );
}

// ── Edit with AI dialog ──────────────────────────────────────────────────

function EditWithAiDialog({
  open,
  onOpenChange,
  artifactId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  artifactId: string | null;
  onDone: (artifact: ArtifactSummary) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [revising, setRevising] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      setInstruction("");
      setStatus(null);
      setError(null);
      setRevising(false);
    }
  }, [open]);

  async function revise() {
    if (!artifactId || !instruction.trim() || revising) return;
    setRevising(true);
    setError(null);
    setStatus("Starting…");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamRevise({
        artifactId,
        instruction: instruction.trim(),
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === "status") setStatus(e.label);
          else if (e.type === "artifact") {
            void invalidateApiPrefix("/api/artifacts");
            onDone(e.artifact);
          } else if (e.type === "error") setError(e.message);
        },
      });
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setError(err instanceof Error ? err.message : "Revision failed.");
      }
    } finally {
      setRevising(false);
      setStatus(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !revising && onOpenChange(v)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WandSparkles className="size-4 text-accent" />
            Edit with AI
          </DialogTitle>
          <DialogDescription>
            Describe the change — Omni rewrites the whole document as a new
            version (the original is kept).
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void revise();
          }}
        >
          <Textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="e.g. “Make the tone more formal and add a risks section”"
            rows={3}
            maxLength={2000}
            autoFocus
            disabled={revising}
          />
          {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={revising}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!instruction.trim() || revising}>
              {revising ? (
                <>
                  <Loader2 className="animate-spin" />
                  {status ?? "Revising…"}
                </>
              ) : (
                "Revise document"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
