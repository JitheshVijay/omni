// /tools/slides/:id: deck viewer + editor. Loads the kind=slides artifact
// (content is DeckContent), renders it in the paged DeckViewer, and offers a
// toolbar: export .pptx (built from the slide JSON, native charts + embedded
// art), print / PDF (DeckViewer's per-slide print frame), "Edit with AI"
// (streamRevise -> navigate to the new revision), Export to Drive (uploads the
// generated .pptx), and Delete.
//
// The load is StrictMode-safe (cancelled flag on the effect, mirroring
// ChatThreadPage / DocEditorPage). A revise navigation changes :id, which
// re-runs the loader for the new deck.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Download,
  HardDriveUpload,
  Loader2,
  MoreHorizontal,
  Pencil,
  Presentation,
  Printer,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { authFetch, invalidateApiPrefix } from "@/lib/use-api";
import { streamRevise } from "@/lib/generate";
import { exportDeckToPptx } from "@/lib/pptx-export";
import { DeckViewer } from "@/components/tools/DeckViewer";
import { FreeformEditor } from "@/components/tools/FreeformEditor";
import { deckToFree, type FreeDeck } from "@/lib/slide-free";
import type { Artifact, ArtifactSummary } from "@/lib/types";
import type { DeckContent, SlideSpec } from "@/lib/slide-types";
import { SaveAsSkillButton } from "@/components/skills/SaveAsSkillButton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
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

type Phase = "loading" | "ready" | "error";

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** Validate that an artifact's content really is a deck we can render. */
function asDeck(content: unknown): DeckContent | null {
  if (!content || typeof content !== "object") return null;
  const c = content as Partial<DeckContent>;
  if (!c.theme || typeof c.theme !== "object") return null;
  if (!Array.isArray(c.slides)) return null;
  return { theme: c.theme, slides: c.slides as SlideSpec[] };
}

function safeName(title: string): string {
  return (title || "deck").replace(/[^\w\s-]/g, "").trim().slice(0, 60) || "deck";
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function DeckEditorPage() {
  // Match the existing tool-route convention (/tools/docs/:artifactId) but
  // tolerate a ":id" param name too, so the page works however the route is
  // wired.
  const params = useParams<{ artifactId?: string; id?: string }>();
  const routeId = params.artifactId ?? params.id;
  const navigate = useNavigate();
  const confirm = useConfirm();

  const [phase, setPhase] = useState<Phase>("loading");
  const [deck, setDeck] = useState<DeckContent | null>(null);
  const [title, setTitle] = useState("");
  const [sourcePrompt, setSourcePrompt] = useState<string | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(routeId ?? null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportedToDrive, setExportedToDrive] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [freeDeck, setFreeDeck] = useState<FreeDeck | null>(null);
  const [editPrefill, setEditPrefill] = useState("");
  const savedTitleRef = useRef("");

  // ── Load on :id (StrictMode-safe) ──────────────────────────────────────
  useEffect(() => {
    if (!routeId) return;
    let cancelled = false;
    setPhase("loading");
    setPageError(null);
    setActionError(null);
    setExportedToDrive(false);
    setArtifactId(routeId);
    (async () => {
      try {
        const art = await authFetch<Artifact>(`/api/artifacts/${routeId}`);
        if (cancelled) return;
        const d = asDeck(art.content);
        if (!d) {
          setPageError("This deck is empty or has an unexpected format.");
          setPhase("error");
          return;
        }
        setDeck(d);
        setTitle(art.title ?? "");
        savedTitleRef.current = art.title ?? "";
        setSourcePrompt(
          typeof art.meta?.prompt === "string" ? (art.meta.prompt as string) : null,
        );
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        setPageError(err instanceof Error ? err.message : "Could not load this deck.");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routeId]);

  // ── Toolbar actions ─────────────────────────────────────────────────────
  async function saveTitle() {
    const t = title.trim() || "Untitled deck";
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

  // Open the hands-on canvas editor: convert the (archetype) deck to freeform.
  function openCanvasEditor() {
    if (!deck) return;
    setFreeDeck(deckToFree(deck));
    setEditing(true);
  }

  // Persist freeform edits back to the artifact content (FreeSlide ∈ SlideSpec,
  // so the saved deck stays a valid DeckContent that the viewer/export render).
  async function saveFreeform(fd: FreeDeck) {
    if (!artifactId) return;
    await authFetch(`/api/artifacts/${artifactId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: fd }),
    });
    setDeck(fd);
    setFreeDeck(fd);
    void invalidateApiPrefix("/api/artifacts");
  }

  async function exportPptx() {
    if (!deck || exporting) return;
    setExporting(true);
    setActionError(null);
    try {
      const blob = await exportDeckToPptx(deck, title);
      downloadBlob(blob, `${safeName(title)}.pptx`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not build the .pptx.");
    } finally {
      setExporting(false);
    }
  }

  async function exportToDrive() {
    if (!deck) return;
    setActionError(null);
    try {
      const blob = await exportDeckToPptx(deck, title);
      const file = new File([blob], `${safeName(title)}.pptx`, { type: PPTX_MIME });
      const fd = new FormData();
      fd.append("file", file);
      await authFetch(`/api/drive/files`, { method: "POST", body: fd });
      void invalidateApiPrefix("/api/drive/files");
      setExportedToDrive(true);
      setTimeout(() => setExportedToDrive(false), 2500);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Export to Drive failed.");
    }
  }

  async function removeDeck() {
    if (!artifactId) return;
    const ok = await confirm({
      title: "Delete deck?",
      message: <>“{title || "Untitled"}” will be permanently removed.</>,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await authFetch(`/api/artifacts/${artifactId}`, { method: "DELETE" });
      void invalidateApiPrefix("/api/artifacts");
      navigate("/tools/slides");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  const openEdit = useCallback((prefill: string) => {
    setEditPrefill(prefill);
    setEditOpen(true);
  }, []);

  // ── Error phase ─────────────────────────────────────────────────────────
  if (phase === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Presentation className="size-10 text-muted/50" />
        <p className="font-display text-lg font-semibold text-ink">
          Couldn't open this deck
        </p>
        <p className="max-w-sm text-sm text-muted">{pageError}</p>
        <Button variant="secondary" asChild>
          <Link to="/tools/slides">Back to Slides</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-screen min-h-0 flex-col">
      {/* Toolbar */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5 md:px-6">
        <Button variant="ghost" size="iconSm" asChild aria-label="Back to Slides">
          <Link to="/tools/slides">
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
          placeholder="Untitled deck"
          aria-label="Deck title"
          className="min-w-0 flex-1 truncate rounded-md bg-transparent px-2 py-1 font-display text-sm font-semibold text-ink outline-none transition placeholder:text-muted hover:bg-ink/[0.03] focus:bg-ink/[0.04] focus:ring-2 focus:ring-accent/30 md:text-base"
        />

        <Button
          size="sm"
          variant="secondary"
          onClick={() => void exportPptx()}
          disabled={phase !== "ready" || exporting}
        >
          {exporting ? <Loader2 className="animate-spin" /> : <Download />}
          Export .pptx
        </Button>

        <Button
          size="sm"
          variant="secondary"
          onClick={openCanvasEditor}
          disabled={phase !== "ready"}
        >
          <Pencil />
          Edit
        </Button>

        <Button
          size="sm"
          variant="secondary"
          onClick={() => openEdit("")}
          disabled={phase !== "ready"}
        >
          <WandSparkles />
          Edit with AI
        </Button>

        <SaveAsSkillButton
          target="slides"
          defaultName={title || undefined}
          defaultPrompt={sourcePrompt || title || ""}
          disabled={phase !== "ready"}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="iconSm" variant="ghost" aria-label="More actions">
              {exportedToDrive ? (
                <Check className="text-emerald-500" />
              ) : (
                <MoreHorizontal />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
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
              onSelect={() => void removeDeck()}
              disabled={!artifactId}
            >
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {actionError && (
        <p className="border-b border-rose-500/20 bg-rose-500/[0.06] px-6 py-1.5 text-xs text-rose-600 dark:text-rose-400">
          {actionError}
        </p>
      )}

      {/* Body */}
      {phase === "loading" || !deck ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-6 md:p-8">
          <Skeleton className="min-h-0 flex-1 rounded-xl" />
          <div className="flex gap-2.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[84px] w-[148px] shrink-0 rounded-lg" />
            ))}
          </div>
        </div>
      ) : editing && freeDeck ? (
        <div className="min-h-0 flex-1">
          <FreeformEditor
            deck={freeDeck}
            title={title}
            onSave={saveFreeform}
            onExit={() => setEditing(false)}
          />
        </div>
      ) : (
        <DeckViewer deck={deck} onRevise={openEdit} className="flex-1" />
      )}

      <EditWithAiDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        artifactId={artifactId}
        initialInstruction={editPrefill}
        onDone={(a) => {
          setEditOpen(false);
          navigate(`/tools/slides/${a.id}`);
        }}
      />
    </div>
  );
}

// ── Edit with AI dialog ────────────────────────────────────────────────────

function EditWithAiDialog({
  open,
  onOpenChange,
  artifactId,
  initialInstruction,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  artifactId: string | null;
  initialInstruction: string;
  onDone: (artifact: ArtifactSummary) => void;
}) {
  const [instruction, setInstruction] = useState(initialInstruction);
  const [revising, setRevising] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Seed the field with the slide-scoped prefill each time the dialog opens;
  // reset everything when it closes.
  useEffect(() => {
    if (open) {
      setInstruction(initialInstruction);
      setError(null);
      setStatus(null);
    } else {
      abortRef.current?.abort();
      setRevising(false);
    }
  }, [open, initialInstruction]);

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
            Describe the change, and Omni rebuilds the deck as a new revision (the
            original is kept). Reused slide art carries over.
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
            placeholder="e.g. “Add a competitive-landscape slide and switch to the Daylight theme”"
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
                "Revise deck"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
