// /hubs — grid of hub cards (name, description, file/thread counts) plus a
// create dialog. Hubs are project workspaces: custom instructions, attached
// Drive files, and persistent memory that grounds every thread inside them.

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { FileText, FolderKanban, MessageSquare, Plus } from "lucide-react";
import { useApi, authFetch, invalidateApi } from "@/lib/use-api";
import type { Hub } from "@/lib/types";
import { timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Eyebrow } from "@/components/brand/Eyebrow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export default function HubsListPage() {
  const { data, isInitialLoading } = useApi<{ hubs: Hub[] }>("/api/hubs");
  const hubs = data?.hubs ?? [];

  return (
    <div className="mx-auto flex h-screen max-w-5xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      <div className="mb-6 flex items-center justify-between gap-4 pl-10 lg:pl-0">
        <div>
          <Eyebrow>Hubs</Eyebrow>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">
            Hubs
          </h1>
          <p className="mt-1 text-sm text-muted">
            Project workspaces with instructions, files, and persistent memory.
          </p>
        </div>
        <CreateHubDialog />
      </div>

      {isInitialLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : hubs.length === 0 ? (
        <div className="mt-16 flex flex-col items-center gap-3 text-center">
          <div className="grid size-12 place-items-center rounded-lg bg-ink text-surface">
            <FolderKanban className="size-6" />
          </div>
          <p className="font-display text-lg font-semibold text-ink">No hubs yet</p>
          <p className="max-w-sm text-sm text-muted">
            Create a hub to give your chats a home — attach files, add custom
            instructions, and let Omni answer from your own documents.
          </p>
          <CreateHubDialog triggerLabel="Create your first hub" />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {hubs.map((hub, i) => (
            <motion.div
              key={hub.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: Math.min(i * 0.04, 0.3) }}
            >
              <Link
                to={`/hubs/${hub.id}`}
                className="group flex h-full flex-col rounded-lg border border-line bg-surface p-5 transition hover:border-accent/40 hover:bg-surface2"
              >
                <div className="mb-3 grid size-9 place-items-center rounded-lg bg-ink text-surface">
                  <FolderKanban className="size-5" />
                </div>
                <h2 className="font-display text-base font-semibold text-ink group-hover:text-accent">
                  {hub.name}
                </h2>
                <p className="mt-1 line-clamp-2 flex-1 text-sm text-muted">
                  {hub.description || "No description."}
                </p>
                <div className="mt-4 flex items-center gap-3 text-[11px] text-muted">
                  <span className="inline-flex items-center gap-1">
                    <FileText className="size-3" />
                    {hub.file_count ?? 0} file{(hub.file_count ?? 0) === 1 ? "" : "s"}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <MessageSquare className="size-3" />
                    {hub.thread_count ?? 0} chat{(hub.thread_count ?? 0) === 1 ? "" : "s"}
                  </span>
                  <span className="ml-auto">{timeAgo(hub.updated_at)}</span>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateHubDialog({ triggerLabel = "New hub" }: { triggerLabel?: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const hub = await authFetch<Hub>("/api/hubs", {
        method: "POST",
        body: JSON.stringify({
          name: trimmed,
          ...(description.trim() ? { description: description.trim() } : {}),
        }),
      });
      void invalidateApi("/api/hubs");
      setOpen(false);
      navigate(`/hubs/${hub.id}`);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? "Could not create hub.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setName("");
          setDescription("");
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a hub</DialogTitle>
          <DialogDescription>
            A workspace with its own files, instructions, and memory.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Name
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q3 launch research"
              autoFocus
              maxLength={120}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Description <span className="font-normal text-muted">(optional)</span>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What lives in this hub?"
              rows={3}
            />
          </label>
          {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
          <DialogFooter className="mt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || saving}>
              {saving ? "Creating…" : "Create hub"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
