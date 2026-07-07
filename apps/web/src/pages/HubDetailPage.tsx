// /hubs/:hubId — tabbed hub workspace:
//   Overview  — name / description / instructions / default-model form.
//   Files     — attached Drive files with live index_status (5s poll while
//               anything is pending/extracting/embedding), attach-from-Drive
//               dialog, detach.
//   Threads   — chats living in this hub + "new chat in hub".
//   Memory    — semantic search over the hub's indexed chunks.

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  FileText,
  FolderKanban,
  Link2,
  Loader2,
  MessageSquare,
  Plus,
  Search,
  Unlink,
} from "lucide-react";
import {
  useApi,
  authFetch,
  invalidateApi,
  invalidateApiPrefix,
} from "@/lib/use-api";
import type {
  ChatThread,
  DriveFile,
  Hub,
  MemorySearchResult,
} from "@/lib/types";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge, IndexStatusBadge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { VoiceCallButton } from "@/components/voice/VoiceCallButton";
import { ModelPicker } from "@/components/chat/ModelPicker";
import { Eyebrow } from "@/components/brand/Eyebrow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Tab = "overview" | "files" | "threads" | "memory";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "files", label: "Files" },
  { id: "threads", label: "Threads" },
  { id: "memory", label: "Memory" },
];

interface HubPayload {
  hub: Hub;
  files: DriveFile[];
  threads: ChatThread[];
}

const INDEXING_STATES = new Set(["pending", "extracting", "embedding"]);

export default function HubDetailPage() {
  const { hubId } = useParams<{ hubId: string }>();
  const [tab, setTab] = useState<Tab>("overview");

  const hubPath = hubId ? `/api/hubs/${hubId}` : null;
  // Poll while any attached file is mid-pipeline so status badges go green
  // without a manual refresh.
  const { data, error, isInitialLoading } = useApi<HubPayload>(hubPath, {
    refreshInterval: (latest) =>
      latest?.files?.some((f) => INDEXING_STATES.has(f.index_status)) ? 5000 : 0,
  });

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <FolderKanban className="size-10 text-muted/50" />
        <p className="font-display text-lg font-semibold text-ink">
          Couldn't load this hub
        </p>
        <p className="max-w-sm text-sm text-muted">{error.message}</p>
        <Button variant="secondary" asChild>
          <Link to="/hubs">Back to hubs</Link>
        </Button>
      </div>
    );
  }

  const hub = data?.hub ?? null;
  const files = data?.files ?? [];
  const threads = data?.threads ?? [];

  return (
    <div className="mx-auto flex h-screen max-w-4xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      <div className="mb-1 pl-10 lg:pl-0">
        <Link
          to="/hubs"
          className="inline-flex items-center gap-1 text-xs text-muted transition hover:text-ink"
        >
          <ArrowLeft className="size-3" />
          All hubs
        </Link>
      </div>

      <div className="mb-5 flex items-start justify-between gap-4 pl-10 lg:pl-0">
        <div className="min-w-0">
          <Eyebrow>Hub</Eyebrow>
          {isInitialLoading ? (
            <Skeleton className="mt-1 h-8 w-64" />
          ) : (
            <h1 className="mt-1 truncate font-display text-2xl font-semibold tracking-tight text-ink">
              {hub?.name}
            </h1>
          )}
          {hub?.description && (
            <p className="mt-1 line-clamp-2 text-sm text-muted">{hub.description}</p>
          )}
        </div>
        {hubId && (
          <div className="flex shrink-0 items-center gap-2">
            <VoiceCallButton hubId={hubId} />
            <NewHubChatButton hubId={hubId} />
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="mb-6 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px border-b-2 px-3.5 py-2 text-sm font-medium transition",
              tab === t.id
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:border-line hover:text-ink",
            )}
          >
            {t.label}
            {t.id === "files" && files.length > 0 && (
              <span className="ml-1.5 text-[11px] text-muted">{files.length}</span>
            )}
            {t.id === "threads" && threads.length > 0 && (
              <span className="ml-1.5 text-[11px] text-muted">{threads.length}</span>
            )}
          </button>
        ))}
      </div>

      {isInitialLoading || !hub || !hubId ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-9 w-1/2" />
        </div>
      ) : (
        <>
          {tab === "overview" && <OverviewTab hub={hub} />}
          {tab === "files" && <FilesTab hubId={hubId} files={files} />}
          {tab === "threads" && <ThreadsTab hubId={hubId} threads={threads} />}
          {tab === "memory" && <MemoryTab hubId={hubId} />}
        </>
      )}
    </div>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────

function OverviewTab({ hub }: { hub: Hub }) {
  const [name, setName] = useState(hub.name);
  const [description, setDescription] = useState(hub.description ?? "");
  const [instructions, setInstructions] = useState(hub.instructions ?? "");
  const [defaultModel, setDefaultModel] = useState<string | null>(hub.default_model);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const dirty =
    name !== hub.name ||
    description !== (hub.description ?? "") ||
    instructions !== (hub.instructions ?? "") ||
    defaultModel !== hub.default_model;

  async function save() {
    if (!dirty || saving || !name.trim()) return;
    setSaving(true);
    setFeedback(null);
    try {
      await authFetch(`/api/hubs/${hub.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          instructions: instructions.trim() || null,
          default_model: defaultModel,
        }),
      });
      await invalidateApi(`/api/hubs/${hub.id}`);
      void invalidateApi("/api/hubs");
      setFeedback({ kind: "ok", text: "Saved." });
      setTimeout(() => setFeedback(null), 2500);
    } catch (err) {
      setFeedback({
        kind: "err",
        text:
          err instanceof Error
            ? err.message
            : (err as { message?: string })?.message ?? "Save failed.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex max-w-2xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
        Name
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
        Description
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="What lives in this hub?"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
        Instructions
        <span className="text-xs font-normal text-muted">
          Prepended to the system prompt of every chat in this hub.
        </span>
        <Textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={5}
          placeholder="e.g. Answer as a terse staff engineer. Prefer tables. Always cite sources."
        />
      </label>
      <div className="flex flex-col gap-1.5 text-sm font-medium text-ink">
        Default model
        <span className="text-xs font-normal text-muted">
          New chats in this hub start with this model. "Use default" falls back to
          your global setting.
        </span>
        <ModelPicker
          value={defaultModel}
          onChange={setDefaultModel}
          allowDefault
          defaultLabel="Use global default"
          className="max-w-sm"
        />
      </div>
      <div className="mt-1 flex items-center gap-3">
        <Button type="submit" disabled={!dirty || saving || !name.trim()}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
        {feedback && (
          <span
            className={cn(
              "text-sm",
              feedback.kind === "ok"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400",
            )}
          >
            {feedback.text}
          </span>
        )}
      </div>
    </form>
  );
}

// ── Files ────────────────────────────────────────────────────────────────

function FilesTab({ hubId, files }: { hubId: string; files: DriveFile[] }) {
  const confirm = useConfirm();
  const [attachOpen, setAttachOpen] = useState(false);

  async function detach(file: DriveFile) {
    const ok = await confirm({
      title: "Detach file?",
      message: (
        <>
          “{file.name}” stays in your Drive, but its memory chunks are removed from
          this hub.
        </>
      ),
      confirmLabel: "Detach",
      danger: true,
    });
    if (!ok) return;
    try {
      await authFetch(`/api/hubs/${hubId}/files/${file.id}`, { method: "DELETE" });
    } finally {
      void invalidateApi(`/api/hubs/${hubId}`);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Attached files are chunked, embedded, and searchable in every chat in this
          hub.
        </p>
        <Button variant="secondary" onClick={() => setAttachOpen(true)}>
          <Link2 />
          Attach from Drive
        </Button>
      </div>

      {files.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line py-12 text-center">
          <FileText className="size-8 text-muted/50" />
          <p className="text-sm text-muted">
            No files attached yet. Attach from Drive to build this hub's memory.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface2">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-4 py-3">
              <FileText className="size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{f.name}</p>
                <p className="text-[11px] text-muted">
                  {formatBytes(f.size_bytes)} · added {timeAgo(f.created_at)}
                </p>
              </div>
              <IndexStatusBadge status={f.index_status} title={f.index_error ?? undefined} />
              <button
                type="button"
                onClick={() => void detach(f)}
                className="rounded-md p-1.5 text-muted transition hover:bg-rose-500/10 hover:text-rose-500"
                title="Detach from hub"
                aria-label={`Detach ${f.name}`}
              >
                <Unlink className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <AttachFromDriveDialog
        hubId={hubId}
        open={attachOpen}
        onOpenChange={setAttachOpen}
        attachedIds={new Set(files.map((f) => f.id))}
      />
    </div>
  );
}

function AttachFromDriveDialog({
  hubId,
  open,
  onOpenChange,
  attachedIds,
}: {
  hubId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  attachedIds: Set<string>;
}) {
  const { data, isInitialLoading } = useApi<{ files: DriveFile[] }>(
    open ? "/api/drive/files" : null,
  );
  const [attaching, setAttaching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const candidates = (data?.files ?? []).filter((f) => !attachedIds.has(f.id));

  async function attach(file: DriveFile) {
    setAttaching(file.id);
    setError(null);
    try {
      await authFetch(`/api/hubs/${hubId}/files`, {
        method: "POST",
        body: JSON.stringify({ file_id: file.id }),
      });
      void invalidateApi(`/api/hubs/${hubId}`);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? "Attach failed.",
      );
    } finally {
      setAttaching(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Attach from Drive</DialogTitle>
          <DialogDescription>
            Attaching queues the file for indexing into this hub's memory.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="max-h-80 overflow-y-auto scrollbar-thin -mx-1 px-1">
          {isInitialLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : candidates.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              Nothing to attach — every Drive file is already in this hub, or your
              Drive is empty.{" "}
              <Link to="/drive" className="text-accent underline">
                Open Drive
              </Link>
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {candidates.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-ink/5"
                >
                  <FileText className="size-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{f.name}</p>
                    <p className="text-[11px] text-muted">{formatBytes(f.size_bytes)}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={attaching === f.id}
                    onClick={() => void attach(f)}
                  >
                    {attaching === f.id ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Plus />
                    )}
                    Attach
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Threads ──────────────────────────────────────────────────────────────

function ThreadsTab({ hubId, threads }: { hubId: string; threads: ChatThread[] }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Chats in this hub see its instructions and search its memory.
        </p>
        <NewHubChatButton hubId={hubId} variant="secondary" />
      </div>
      {threads.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line py-12 text-center">
          <MessageSquare className="size-8 text-muted/50" />
          <p className="text-sm text-muted">No chats in this hub yet.</p>
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface2">
          {threads.map((t) => (
            <li key={t.id}>
              <Link
                to={`/chat/${t.id}`}
                className="flex items-center gap-3 px-4 py-3 transition hover:bg-ink/[0.03]"
              >
                <MessageSquare className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                  {t.title || "New chat"}
                </span>
                <span className="shrink-0 text-[11px] text-muted">
                  {timeAgo(t.updated_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewHubChatButton({
  hubId,
  variant = "default",
}: {
  hubId: string;
  variant?: "default" | "secondary";
}) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      const thread = await authFetch<ChatThread>("/api/chat/threads", {
        method: "POST",
        body: JSON.stringify({ hub_id: hubId }),
      });
      void invalidateApiPrefix("/api/chat/threads");
      void invalidateApi(`/api/hubs/${hubId}`);
      navigate(`/chat/${thread.id}`);
    } catch {
      setCreating(false);
    }
  }

  return (
    <Button variant={variant} onClick={() => void create()} disabled={creating}>
      {creating ? <Loader2 className="animate-spin" /> : <Plus />}
      New chat in hub
    </Button>
  );
}

// ── Memory search ────────────────────────────────────────────────────────

function MemoryTab({ hubId }: { hubId: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MemorySearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bestScore = useMemo(
    () => (results && results.length > 0 ? Math.max(...results.map((r) => r.score)) : 1),
    [results],
  );

  async function search() {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    try {
      const data = await authFetch<{ results: MemorySearchResult[] }>(
        `/api/hubs/${hubId}/memory/search`,
        { method: "POST", body: JSON.stringify({ query: q }) },
      );
      setResults(data.results ?? []);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? "Search failed.",
      );
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Semantic search over everything indexed into this hub — the same retrieval
        chats use to ground their answers.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What does the report say about churn?"
          className="flex-1"
        />
        <Button type="submit" disabled={!query.trim() || searching}>
          {searching ? <Loader2 className="animate-spin" /> : <Search />}
          Search
        </Button>
      </form>

      {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}

      {results !== null && !searching && results.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line py-10 text-center">
          <Search className="size-7 text-muted/50" />
          <p className="text-sm text-muted">
            No matches. Attach files (and wait for indexing) to build memory.
          </p>
        </div>
      )}

      {results && results.length > 0 && (
        <ul className="flex flex-col gap-3">
          {results.map((r) => (
            <li
              key={r.id ?? r.chunk_id}
              className="rounded-xl border border-line bg-surface2 p-4"
            >
              <div className="mb-2 flex items-center gap-2">
                <Badge variant="default">{r.cite_label}</Badge>
                {r.section_title && (
                  <span className="truncate text-[11px] text-muted">{r.section_title}</span>
                )}
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted">
                  {(r.score * 100).toFixed(0)}%
                </span>
              </div>
              {/* Relevance bar, normalized against the best hit. */}
              <div className="mb-2.5 h-1 overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{
                    width: `${Math.max(6, (r.score / Math.max(bestScore, 0.0001)) * 100)}%`,
                  }}
                />
              </div>
              <p className="line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed text-ink/85">
                {r.chunk_text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
