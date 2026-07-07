// /tools/fullstack/:id: the App Builder viewer. Loads a project (flat row +
// file tree) via useApi (SWR). While the build is still running it polls every
// 4s until a terminal status, then swaps in the live preview.
//
// - ready       => iframe the live https preview_url (+ an Open button).
// - no_sandbox  => a banner telling the user to add E2B_API_KEY; code still shown.
// - failed      => the error in a rose-tinted panel.
// A Preview / Code tab pair surfaces the generated files either way.

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Boxes,
  Code2,
  ExternalLink,
  Eye,
  FileCode,
  KeyRound,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { useApi } from "@/lib/use-api";
import {
  STATUS_META,
  isBuildingStatus,
  langForPath,
  type FullstackProjectDetail,
} from "@/lib/fullstack";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CodeBlock } from "@/components/CodeBlock";

type Tab = "preview" | "code";

export default function FullstackViewPage() {
  const { id } = useParams<{ id: string }>();

  const {
    data: project,
    isInitialLoading,
    error,
  } = useApi<FullstackProjectDetail>(id ? `/api/fullstack/projects/${id}` : null, {
    // Poll while the build is in flight; stop once it reaches a terminal status.
    refreshInterval: (latest) => (latest && isBuildingStatus(latest.status) ? 4000 : 0),
  });

  const [tab, setTab] = useState<Tab>("preview");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // ── Loading / error ──────────────────────────────────────────────────────
  if (isInitialLoading) {
    return (
      <div className="mx-auto flex h-screen w-full max-w-6xl flex-col gap-4 px-6 py-8 md:px-10">
        <Skeleton className="h-8 w-40 rounded-lg" />
        <Skeleton className="flex-1 rounded-2xl" />
      </div>
    );
  }
  if (error || !project) {
    return (
      <div className="mx-auto flex h-screen w-full max-w-2xl flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="grid size-12 place-items-center rounded-lg bg-ink text-surface">
          <Boxes className="size-6" />
        </div>
        <p className="font-display text-lg font-semibold text-ink">App not found</p>
        <p className="max-w-xs text-sm text-muted">
          This app may have been deleted. Head back to the App Builder to build a
          new one.
        </p>
        <Button variant="secondary" asChild>
          <Link to="/tools/fullstack">
            <ArrowLeft />
            Back to App Builder
          </Link>
        </Button>
      </div>
    );
  }

  const meta = STATUS_META[project.status] ?? STATUS_META.queued;
  const building = isBuildingStatus(project.status);
  const files = project.files ?? [];
  const selected = files.find((f) => f.path === selectedPath) ?? files[0] ?? null;

  return (
    <div className="mx-auto flex h-screen w-full max-w-6xl flex-col overflow-hidden px-6 py-6 md:px-10">
      {/* Header */}
      <div className="mb-3 flex items-center gap-3 pl-10 lg:pl-0">
        <Button variant="ghost" size="iconSm" asChild aria-label="Back to App Builder">
          <Link to="/tools/fullstack">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-display text-lg font-semibold text-ink">
              {project.name || "Untitled app"}
            </h1>
            <Badge variant={meta.variant}>
              {meta.building && <Loader2 className="size-3 animate-spin" />}
              {meta.label}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted">
            {project.summary || `Updated ${timeAgo(project.updated_at)}`}
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
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

        {project.status === "ready" && project.preview_url && (
          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" size="sm" asChild>
              <a href={project.preview_url} target="_blank" rel="noopener noreferrer">
                <ExternalLink />
                <span className="hidden sm:inline">Open</span>
              </a>
            </Button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-surface2">
        {tab === "preview" ? (
          <PreviewPane project={project} building={building} />
        ) : (
          <CodePane
            files={files}
            selected={selected}
            onSelect={(path) => setSelectedPath(path)}
          />
        )}
      </div>
    </div>
  );
}

// ── Preview pane ────────────────────────────────────────────────────────────

function PreviewPane({
  project,
  building,
}: {
  project: FullstackProjectDetail;
  building: boolean;
}) {
  if (building) {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex flex-col items-center gap-3 text-muted">
          <Loader2 className="size-7 animate-spin text-accent" />
          <p className="text-sm font-medium text-ink">Building…</p>
          <p className="max-w-xs text-center text-xs">
            Generating the code, provisioning a cloud sandbox, and starting the dev
            server. This can take a minute.
          </p>
        </div>
      </div>
    );
  }

  if (project.status === "failed") {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/5 px-6 py-8 text-center">
          <TriangleAlert className="size-7 text-rose-500" />
          <p className="font-display text-base font-semibold text-ink">Build failed</p>
          <p className="text-sm text-rose-600 dark:text-rose-400">
            {project.error || "Something went wrong while building this app."}
          </p>
        </div>
      </div>
    );
  }

  if (project.status === "no_sandbox") {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="flex max-w-lg flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-6 py-8 text-center">
          <div className="grid size-12 place-items-center rounded-lg bg-ink text-surface">
            <KeyRound className="size-6" />
          </div>
          <p className="font-display text-base font-semibold text-ink">
            Add E2B_API_KEY to run this app live
          </p>
          <p className="text-sm text-muted">
            The code was generated, but no cloud sandbox is configured. Grab a key
            from e2b.dev, add <code className="rounded bg-ink/5 px-1 py-0.5 font-mono text-[12px]">E2B_API_KEY</code> to{" "}
            <code className="rounded bg-ink/5 px-1 py-0.5 font-mono text-[12px]">~/omni/.env</code>, and
            restart the API. Meanwhile, the generated code is in the Code tab.
          </p>
          <Button variant="secondary" size="sm" asChild>
            <a href="https://e2b.dev" target="_blank" rel="noopener noreferrer">
              <ExternalLink />
              Get an E2B key
            </a>
          </Button>
        </div>
      </div>
    );
  }

  if (project.status === "ready" && project.preview_url) {
    return (
      <iframe
        title="App preview"
        src={project.preview_url}
        // External https origin (an E2B sandbox). allow-same-origin so the app
        // can use storage/cookies against its own origin; allow-forms for POSTs.
        sandbox="allow-scripts allow-same-origin allow-forms"
        className="h-full w-full border-0 bg-white"
      />
    );
  }

  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <p className="max-w-xs text-sm text-muted">
        No live preview is available for this app.
      </p>
    </div>
  );
}

// ── Code pane ───────────────────────────────────────────────────────────────

function CodePane({
  files,
  selected,
  onSelect,
}: {
  files: FullstackProjectDetail["files"];
  selected: FullstackProjectDetail["files"][number] | null;
  onSelect: (path: string) => void;
}) {
  if (files.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <p className="max-w-xs text-sm text-muted">No files were generated.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col sm:flex-row">
      {/* File list */}
      <div className="shrink-0 overflow-auto scrollbar-thin border-b border-line sm:h-full sm:w-60 sm:border-b-0 sm:border-r">
        <ul className="flex flex-col p-1.5">
          {files.map((f) => {
            const active = selected?.path === f.path;
            return (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => onSelect(f.path)}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[12px] transition",
                    active ? "bg-ink text-surface" : "text-muted hover:bg-ink/5 hover:text-ink",
                  )}
                  title={f.path}
                >
                  <FileCode className="size-3.5 shrink-0" />
                  <span className="truncate font-mono">{f.path}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* File content */}
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin p-3">
        {selected ? (
          <CodeBlock code={selected.content} lang={langForPath(selected.path)} />
        ) : (
          <p className="text-sm text-muted">Select a file to view its contents.</p>
        )}
      </div>
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
        active ? "bg-ink text-surface" : "text-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
