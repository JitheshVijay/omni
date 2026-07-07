// /tools/apps/:artifactId: the AI Developer viewer. Loads a kind=webpage
// artifact (content.html) and shows it two ways: a big LIVE preview in a
// sandboxed iframe (allow-scripts + allow-forms; the doc is self-contained so
// nothing else is granted) with a desktop/mobile width toggle, and a Code tab
// with the raw HTML. Toolbar: Edit with AI (revise -> new artifact -> navigate),
// Export .html, Open in new tab, Export to Drive, Delete.
//
// The load goes through useApi (SWR), which is StrictMode double-mount safe.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Code2,
  Download,
  ExternalLink,
  Eye,
  HardDriveUpload,
  Loader2,
  Monitor,
  Smartphone,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { useApi, authFetch, invalidateApi, invalidateApiPrefix } from "@/lib/use-api";
import { streamRevise } from "@/lib/generate";
import type { Artifact } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { CodeBlock } from "@/components/CodeBlock";

const LIST_PATH = "/api/artifacts?kind=webpage&limit=50";

type Tab = "preview" | "code";
type Device = "desktop" | "mobile";

function htmlOf(artifact: Artifact | undefined): string {
  const content = artifact?.content as { html?: unknown } | null | undefined;
  return typeof content?.html === "string" ? content.html : "";
}

function safeFilename(title: string): string {
  const base = (title || "app").slice(0, 60).replace(/[^\w\s-]/g, "").trim();
  return `${base || "app"}.html`;
}

export default function WebAppViewPage() {
  const { artifactId } = useParams<{ artifactId: string }>();
  const navigate = useNavigate();
  const confirm = useConfirm();

  const { data: artifact, isInitialLoading, error } = useApi<Artifact>(
    artifactId ? `/api/artifacts/${artifactId}` : null,
  );
  const html = htmlOf(artifact);

  const [tab, setTab] = useState<Tab>("preview");
  const [device, setDevice] = useState<Device>("desktop");

  const [instruction, setInstruction] = useState("");
  const [revising, setRevising] = useState(false);
  const [reviseStatus, setReviseStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [exported, setExported] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Reset per-artifact UI state when navigating between apps (e.g. after a
  // revise swaps in the new id).
  const lastIdRef = useRef<string | null>(null);
  if (artifactId && lastIdRef.current !== artifactId) {
    lastIdRef.current = artifactId;
    if (exported) setExported(false);
    if (instruction) setInstruction("");
    if (actionError) setActionError(null);
  }

  const style =
    typeof artifact?.meta?.style === "string" ? (artifact.meta.style as string) : null;

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
            navigate(`/tools/apps/${e.artifact.id}`);
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

  function download() {
    if (!artifact) return;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = safeFilename(artifact.title);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function openInNewTab() {
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    // Revoke a little later so the new tab has time to load.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function exportToDrive() {
    if (!artifactId) return;
    setBusyAction("export");
    setActionError(null);
    try {
      await authFetch(`/api/artifacts/${artifactId}/export-to-drive`, { method: "POST" });
      void invalidateApiPrefix("/api/drive/files");
      setExported(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function remove() {
    if (!artifactId || !artifact) return;
    const ok = await confirm({
      title: "Delete app?",
      message: <>“{artifact.title}” will be permanently removed. This can't be undone.</>,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusyAction("delete");
    try {
      await authFetch(`/api/artifacts/${artifactId}`, { method: "DELETE" });
      void invalidateApi(LIST_PATH);
      void invalidateApiPrefix("/api/artifacts");
      navigate("/tools/apps");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Delete failed.");
      setBusyAction(null);
    }
  }

  // ── Loading / error ──────────────────────────────────────────────────────
  if (isInitialLoading) {
    return (
      <div className="mx-auto flex h-screen w-full max-w-6xl flex-col gap-4 px-6 py-8 md:px-10">
        <Skeleton className="h-8 w-40 rounded-lg" />
        <Skeleton className="flex-1 rounded-2xl" />
      </div>
    );
  }
  if (error || !artifact) {
    return (
      <div className="mx-auto flex h-screen w-full max-w-2xl flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="grid size-12 place-items-center rounded-lg bg-ink text-surface">
          <Code2 className="size-6" />
        </div>
        <p className="font-display text-lg font-semibold text-ink">App not found</p>
        <p className="max-w-xs text-sm text-muted">
          This app may have been deleted. Head back to the AI Developer to build a
          new one.
        </p>
        <Button variant="secondary" asChild>
          <Link to="/tools/apps">
            <ArrowLeft />
            Back to AI Developer
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-6xl flex-col overflow-hidden px-6 py-6 md:px-10">
      {/* Header */}
      <div className="mb-3 flex items-center gap-3 pl-10 lg:pl-0">
        <Button variant="ghost" size="iconSm" asChild aria-label="Back to AI Developer">
          <Link to="/tools/apps">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-lg font-semibold text-ink">
            {artifact.title || "Untitled app"}
          </h1>
          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            {style && (
              <span className="rounded-full border border-line bg-surface px-1.5 py-0.5 uppercase tracking-wide">
                {style}
              </span>
            )}
            Updated {timeAgo(artifact.created_at)}
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* Tab switch */}
        <div className="flex rounded-lg border border-line bg-surface2 p-0.5">
          <TabButton active={tab === "preview"} onClick={() => setTab("preview")}>
            <Eye className="size-4" />
            Preview
          </TabButton>
          <TabButton active={tab === "code"} onClick={() => setTab("code")}>
            <Code2 className="size-4" />
            Code
          </TabButton>
        </div>

        {/* Device toggle (preview only) */}
        {tab === "preview" && (
          <div className="flex rounded-lg border border-line bg-surface2 p-0.5">
            <TabButton active={device === "desktop"} onClick={() => setDevice("desktop")}>
              <Monitor className="size-4" />
              <span className="sr-only sm:not-sr-only">Desktop</span>
            </TabButton>
            <TabButton active={device === "mobile"} onClick={() => setDevice("mobile")}>
              <Smartphone className="size-4" />
              <span className="sr-only sm:not-sr-only">Mobile</span>
            </TabButton>
          </div>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={openInNewTab}>
            <ExternalLink />
            <span className="hidden sm:inline">Open</span>
          </Button>
          <Button variant="secondary" size="sm" onClick={download}>
            <Download />
            <span className="hidden sm:inline">Export .html</span>
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
            <span className="hidden sm:inline">{exported ? "In Drive" : "To Drive"}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-rose-600 hover:text-rose-600 dark:text-rose-400"
            onClick={() => void remove()}
            disabled={busyAction !== null}
          >
            {busyAction === "delete" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Trash2 />
            )}
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-surface2">
        {tab === "preview" ? (
          <div
            className={cn(
              "h-full w-full overflow-auto scrollbar-thin",
              device === "mobile" && "flex justify-center bg-surface3/40 py-4",
            )}
          >
            <iframe
              key={artifact.id}
              title={artifact.title || "App preview"}
              srcDoc={html}
              // allow-same-origin so generated apps can use localStorage /
              // sessionStorage (a sandbox without it throws SecurityError on
              // storage access, crashing any app that persists state). Safe
              // here: a local single-user tool previewing apps the user
              // generated themselves.
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
              className={cn(
                "border-0 bg-white",
                device === "mobile"
                  ? "h-[720px] max-h-full w-[390px] shrink-0 rounded-2xl border border-line"
                  : "h-full w-full",
              )}
            />
          </div>
        ) : (
          <div className="h-full overflow-auto scrollbar-thin p-3">
            <CodeBlock code={html} lang="html" />
          </div>
        )}
      </div>

      {/* Edit with AI */}
      <form
        className="mt-3 flex items-center gap-2"
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
            placeholder="Edit with AI, e.g. “add a dark-mode toggle” or “make the hero full-bleed”"
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
      {actionError && (
        <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{actionError}</p>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition",
        active
          ? "bg-ink text-surface"
          : "text-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
