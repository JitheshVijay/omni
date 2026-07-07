// Kind-aware card for generated artifacts (docs, images, audio) used by the
// Library grid, the Tools "recent creations" strip, and anywhere else a
// creation needs a face. Image cards show the blob as a thumbnail, doc cards
// an icon + prompt excerpt, audio cards an inline <audio> player. The kebab
// menu carries Open / Export to Drive / Delete (with confirm).

import { useState } from "react";
import { motion } from "motion/react";
import {
  AudioLines,
  Check,
  FileText,
  HardDriveUpload,
  Image as ImageIcon,
  Loader2,
  MoreHorizontal,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import { API_BASE, authFetch, invalidateApiPrefix } from "@/lib/use-api";
import type { ArtifactSummary, DriveFile } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function artifactBlobUrl(id: string): string {
  return `${API_BASE}/api/artifacts/${id}/blob`;
}

const KIND_META: Record<string, { label: string; icon: typeof FileText }> = {
  doc: { label: "Doc", icon: FileText },
  image: { label: "Image", icon: ImageIcon },
  audio: { label: "Audio", icon: AudioLines },
};

export interface ArtifactCardProps {
  artifact: ArtifactSummary;
  /** Click-through: parent decides the viewer (doc page, image dialog, …). */
  onOpen?: (artifact: ArtifactSummary) => void;
  /** Fired after a successful delete (list caches are already invalidated). */
  onDeleted?: (artifact: ArtifactSummary) => void;
  className?: string;
}

export function ArtifactCard({ artifact, onOpen, onDeleted, className }: ArtifactCardProps) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = KIND_META[artifact.kind] ?? KIND_META.doc;
  const Icon = meta.icon;
  const prompt =
    typeof artifact.meta?.prompt === "string" ? (artifact.meta.prompt as string) : null;
  const clickable = !!onOpen;

  async function exportToDrive() {
    setBusy(true);
    setError(null);
    try {
      await authFetch<DriveFile>(`/api/artifacts/${artifact.id}/export-to-drive`, {
        method: "POST",
      });
      void invalidateApiPrefix("/api/drive/files");
      void invalidateApiPrefix("/api/artifacts");
      setExported(true);
      setTimeout(() => setExported(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Delete ${meta.label.toLowerCase()}?`,
      message: (
        <>
          “{artifact.title || "Untitled"}” will be permanently removed from your
          library. This can't be undone.
        </>
      ),
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await authFetch(`/api/artifacts/${artifact.id}`, { method: "DELETE" });
      void invalidateApiPrefix("/api/artifacts");
      onDeleted?.(artifact);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
      setBusy(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={cn(
        "group flex flex-col overflow-hidden rounded-lg border border-line bg-surface2 transition",
        clickable && "hover:-translate-y-0.5 hover:border-accent/40",
        className,
      )}
    >
      {/* Preview area */}
      <button
        type="button"
        onClick={() => onOpen?.(artifact)}
        disabled={!clickable}
        className="block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-default"
        aria-label={`Open ${artifact.title || meta.label}`}
      >
        {artifact.kind === "image" && artifact.rel_path ? (
          <div className="aspect-video w-full overflow-hidden bg-ink/5">
            <img
              src={artifactBlobUrl(artifact.id)}
              alt={artifact.title}
              loading="lazy"
              className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
            />
          </div>
        ) : (
          <div className="flex items-start gap-3 px-4 pt-4">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-ink text-surface">
              <Icon className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-sm font-medium leading-snug text-ink">
                {artifact.title || `Untitled ${meta.label.toLowerCase()}`}
              </p>
              {prompt && artifact.kind !== "image" && (
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">
                  {prompt}
                </p>
              )}
            </div>
          </div>
        )}
      </button>

      {/* Image cards get the title UNDER the thumbnail. */}
      {artifact.kind === "image" && (
        <div className="px-4 pt-3">
          <p className="line-clamp-1 text-sm font-medium text-ink" title={artifact.title}>
            {artifact.title || "Untitled image"}
          </p>
        </div>
      )}

      {/* Audio cards get an inline player. */}
      {artifact.kind === "audio" && artifact.rel_path && (
        <div className="px-4 pt-3">
          <audio
            controls
            preload="none"
            src={artifactBlobUrl(artifact.id)}
            className="h-9 w-full"
          />
        </div>
      )}

      {error && (
        <p className="px-4 pt-2 text-[11px] text-rose-600 dark:text-rose-400">{error}</p>
      )}

      {/* Footer: kind, time, kebab */}
      <div className="mt-auto flex items-center gap-2 px-4 py-3">
        <Badge variant="secondary" className="capitalize">
          <Icon className="size-3" />
          {meta.label}
        </Badge>
        {artifact.parent_id && (
          <Badge variant="outline" title="Created by revising another artifact">
            edited
          </Badge>
        )}
        <span className="ml-auto text-[11px] text-muted">{timeAgo(artifact.created_at)}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="rounded-md p-1 text-muted transition hover:bg-ink/10 hover:text-ink"
              aria-label={`Actions for ${artifact.title || meta.label}`}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : exported ? (
                <Check className="size-4 text-emerald-500" />
              ) : (
                <MoreHorizontal className="size-4" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {clickable && (
              <DropdownMenuItem onSelect={() => onOpen?.(artifact)}>
                <SquareArrowOutUpRight />
                Open
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => void exportToDrive()}>
              <HardDriveUpload />
              Export to Drive
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-rose-600 focus:text-rose-600 dark:text-rose-400"
              onSelect={() => void remove()}
            >
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </motion.div>
  );
}
