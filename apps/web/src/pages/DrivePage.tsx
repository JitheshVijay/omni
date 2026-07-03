// /drive — the AI Drive: drag-drop upload zone + file table (name, size,
// mime icon, index status, download/rename/delete actions). The list polls
// every 5s while any file is mid-indexing so status badges resolve without a
// manual refresh. Downloads go through fetch (the API requires a Bearer
// header, so a bare <a href> can't be used) and save via an object URL.

import { useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  HardDrive,
  Loader2,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  UploadCloud,
} from "lucide-react";
import {
  useApi,
  authFetch,
  authFetchRaw,
  invalidateApi,
} from "@/lib/use-api";
import { parseApiError } from "@/lib/api-error";
import type { DriveFile } from "@/lib/types";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { IndexStatusBadge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
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

const INDEXING_STATES = new Set(["pending", "extracting", "embedding"]);

function mimeIcon(mime: string) {
  if (mime.startsWith("image/")) return FileImage;
  if (mime.startsWith("audio/")) return FileAudio;
  if (mime.startsWith("video/")) return FileVideo;
  if (/zip|tar|gzip|compressed/.test(mime)) return FileArchive;
  if (/json|javascript|typescript|xml|html|css/.test(mime)) return FileCode;
  if (
    mime.startsWith("text/") ||
    /pdf|word|document|presentation|sheet|markdown/.test(mime)
  )
    return FileText;
  return FileIcon;
}

export default function DrivePage() {
  const [query, setQuery] = useState("");
  const listPath = query.trim()
    ? `/api/drive/files?q=${encodeURIComponent(query.trim())}`
    : "/api/drive/files";

  const { data, isInitialLoading } = useApi<{ files: DriveFile[] }>(listPath, {
    refreshInterval: (latest) =>
      latest?.files?.some((f) => INDEXING_STATES.has(f.index_status)) ? 5000 : 0,
  });
  const files = data?.files ?? [];

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function uploadFiles(list: FileList | File[]) {
    const items = [...list];
    if (items.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of items) {
        const fd = new FormData();
        fd.append("file", file, file.name);
        await authFetch("/api/drive/files", { method: "POST", body: fd });
      }
    } catch (err) {
      setUploadError(
        err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? "Upload failed.",
      );
    } finally {
      setUploading(false);
      void invalidateApi(listPath);
      void invalidateApi("/api/drive/files");
    }
  }

  return (
    <div className="mx-auto flex h-screen max-w-5xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 pl-10 lg:pl-0">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
            Drive
          </h1>
          <p className="mt-1 text-sm text-muted">
            Files live locally under your Omni data folder — uploads are chunked and
            embedded for hub memory.
          </p>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files…"
            className="w-56 pl-8"
          />
        </div>
      </div>

      <UploadDropzone uploading={uploading} onFiles={uploadFiles} />
      {uploadError && (
        <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{uploadError}</p>
      )}

      <div className="mt-6">
        {isInitialLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : files.length === 0 ? (
          <div className="mt-8 flex flex-col items-center gap-3 text-center">
            <div className="grid size-12 place-items-center rounded-2xl bg-accent/10">
              <HardDrive className="size-6 text-accent" />
            </div>
            <p className="font-display text-lg font-semibold text-ink">
              {query ? "No files match" : "Your Drive is empty"}
            </p>
            <p className="max-w-sm text-sm text-muted">
              {query
                ? "Try a different search."
                : "Drop a PDF, doc, or text file above — it becomes searchable memory for any hub you attach it to."}
            </p>
          </div>
        ) : (
          <FileTable files={files} listPath={listPath} />
        )}
      </div>
    </div>
  );
}

function UploadDropzone({
  uploading,
  onFiles,
}: {
  uploading: boolean;
  onFiles: (files: FileList | File[]) => void | Promise<void>;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files?.length) void onFiles(e.dataTransfer.files);
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition",
        dragging
          ? "border-accent bg-accent/[0.06]"
          : "border-line bg-surface2 hover:border-accent/50 hover:bg-accent/[0.03]",
      )}
      aria-label="Upload files"
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div
        className={cn(
          "grid size-11 place-items-center rounded-xl transition",
          dragging ? "bg-accent text-white" : "bg-accent/10 text-accent",
        )}
      >
        {uploading ? (
          <Loader2 className="size-5 animate-spin" />
        ) : (
          <UploadCloud className="size-5" />
        )}
      </div>
      <p className="text-sm font-medium text-ink">
        {uploading
          ? "Uploading…"
          : dragging
            ? "Drop to upload"
            : "Drag & drop files, or click to browse"}
      </p>
      <p className="text-xs text-muted">Up to 20 MB per file</p>
    </div>
  );
}

function FileTable({ files, listPath }: { files: DriveFile[]; listPath: string }) {
  const confirm = useConfirm();
  const [renameTarget, setRenameTarget] = useState<DriveFile | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  async function download(f: DriveFile) {
    setBusyId(f.id);
    setRowError(null);
    try {
      const res = await authFetchRaw(`/api/drive/files/${f.id}/download`);
      if (!res.ok) throw new Error((await parseApiError(res)).message);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setRowError(
        `Download failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusyId(null);
    }
  }

  async function remove(f: DriveFile) {
    const ok = await confirm({
      title: "Delete file?",
      message: (
        <>
          “{f.name}” will be removed from your Drive and from every hub's memory.
          This can't be undone.
        </>
      ),
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusyId(f.id);
    setRowError(null);
    try {
      await authFetch(`/api/drive/files/${f.id}`, { method: "DELETE" });
    } catch (err) {
      setRowError(
        `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusyId(null);
      void invalidateApi(listPath);
      void invalidateApi("/api/drive/files");
    }
  }

  return (
    <>
      {rowError && (
        <p className="mb-2 text-sm text-rose-600 dark:text-rose-400">{rowError}</p>
      )}
      <div className="overflow-hidden rounded-xl border border-line bg-surface2">
        {/* Header row */}
        <div className="hidden grid-cols-[1fr_90px_120px_110px_40px] items-center gap-3 border-b border-line px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted md:grid">
          <span>Name</span>
          <span>Size</span>
          <span>Status</span>
          <span>Added</span>
          <span />
        </div>
        <ul className="divide-y divide-line">
          {files.map((f, i) => {
            const Icon = mimeIcon(f.mime);
            return (
              <motion.li
                key={f.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.15, delay: Math.min(i * 0.02, 0.2) }}
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 transition hover:bg-ink/[0.02] md:grid-cols-[1fr_90px_120px_110px_40px]"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Icon className="size-4 shrink-0 text-muted" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink" title={f.name}>
                      {f.name}
                    </p>
                    <p className="truncate text-[11px] text-muted md:hidden">
                      {formatBytes(f.size_bytes)} · {timeAgo(f.created_at)}
                    </p>
                  </div>
                </div>
                <span className="hidden text-xs tabular-nums text-muted md:block">
                  {formatBytes(f.size_bytes)}
                </span>
                <span className="hidden md:block">
                  <IndexStatusBadge
                    status={f.index_status}
                    title={f.index_error ?? undefined}
                  />
                </span>
                <span className="hidden text-xs text-muted md:block">
                  {timeAgo(f.created_at)}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="justify-self-end rounded-md p-1.5 text-muted transition hover:bg-ink/10 hover:text-ink"
                      aria-label={`Actions for ${f.name}`}
                      disabled={busyId === f.id}
                    >
                      {busyId === f.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <MoreHorizontal className="size-4" />
                      )}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void download(f)}>
                      <Download />
                      Download
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setRenameTarget(f)}>
                      <Pencil />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-rose-600 focus:text-rose-600 dark:text-rose-400"
                      onSelect={() => void remove(f)}
                    >
                      <Trash2 />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </motion.li>
            );
          })}
        </ul>
      </div>

      <RenameDialog
        file={renameTarget}
        onClose={() => setRenameTarget(null)}
        listPath={listPath}
      />
    </>
  );
}

function RenameDialog({
  file,
  onClose,
  listPath,
}: {
  file: DriveFile | null;
  onClose: () => void;
  listPath: string;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the input each time a new file is targeted.
  const seededFor = useRef<string | null>(null);
  if (file && seededFor.current !== file.id) {
    seededFor.current = file.id;
    // Safe during render: writing state for a NEW render pass input.
    setName(file.name);
    setError(null);
  }
  if (!file && seededFor.current) seededFor.current = null;

  async function save() {
    if (!file || !name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await authFetch(`/api/drive/files/${file.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim() }),
      });
      void invalidateApi(listPath);
      void invalidateApi("/api/drive/files");
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? "Rename failed.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!file} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename file</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            maxLength={255}
          />
          {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
