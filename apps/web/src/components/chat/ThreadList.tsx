// Persistent conversations column for /chat/*. Threads attached to a hub are
// grouped under the hub's name; loose threads live under "Chats". Rows show
// relative timestamps, highlight the active thread, and expose delete via a
// kebab dropdown + confirm dialog.

import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  MessageSquare,
  MoreHorizontal,
  Plus,
  Trash2,
  FolderKanban,
} from "lucide-react";
import { useApi, authFetch, invalidateApiPrefix } from "@/lib/use-api";
import type { ChatThread, Hub } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ThreadGroup {
  key: string;
  label: string;
  isHub: boolean;
  hubId?: string;
  threads: ChatThread[];
}

export function ThreadList() {
  const navigate = useNavigate();
  const { threadId } = useParams<{ threadId: string }>();
  const confirm = useConfirm();

  const { data: threadsData, isInitialLoading } = useApi<{ threads: ChatThread[] }>(
    "/api/chat/threads",
  );
  const { data: hubsData } = useApi<{ hubs: Hub[] }>("/api/hubs");

  const groups = useMemo<ThreadGroup[]>(() => {
    const threads = threadsData?.threads ?? [];
    const hubs = hubsData?.hubs ?? [];
    const hubName = new Map(hubs.map((h) => [h.id, h.name]));

    const loose: ChatThread[] = [];
    const byHub = new Map<string, ChatThread[]>();
    for (const t of threads) {
      if (t.hub_id) {
        const list = byHub.get(t.hub_id) ?? [];
        list.push(t);
        byHub.set(t.hub_id, list);
      } else {
        loose.push(t);
      }
    }

    const result: ThreadGroup[] = [];
    if (loose.length > 0) {
      result.push({ key: "loose", label: "Chats", isHub: false, threads: loose });
    }
    for (const [hubId, list] of byHub) {
      result.push({
        key: `hub:${hubId}`,
        label: hubName.get(hubId) ?? "Hub",
        isHub: true,
        hubId,
        threads: list,
      });
    }
    return result;
  }, [threadsData, hubsData]);

  async function deleteThread(t: ChatThread) {
    const ok = await confirm({
      title: "Delete chat?",
      message: (
        <>
          “{t.title}” and all its messages will be permanently deleted.
        </>
      ),
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await authFetch(`/api/chat/threads/${t.id}`, { method: "DELETE" });
    } finally {
      void invalidateApiPrefix("/api/chat/threads");
    }
    if (t.id === threadId) navigate("/chat", { replace: true });
  }

  return (
    <aside className="hidden md:flex h-full w-64 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <h2 className="font-display text-sm font-semibold text-ink">Conversations</h2>
        <Button
          size="iconSm"
          variant="secondary"
          onClick={() => navigate("/chat")}
          title="New chat"
          aria-label="New chat"
        >
          <Plus />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-3">
        {isInitialLoading ? (
          <div className="space-y-2 px-1 pt-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="mt-10 flex flex-col items-center gap-2 px-4 text-center">
            <MessageSquare className="size-8 text-muted/50" />
            <p className="text-sm text-muted">
              No conversations yet. Start one and it will show up here.
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.key} className="mb-3">
              <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted/70">
                {group.isHub && <FolderKanban className="size-3" />}
                {group.isHub && group.hubId ? (
                  <Link
                    to={`/hubs/${group.hubId}`}
                    className="truncate transition hover:text-accent"
                    title={`Open hub: ${group.label}`}
                  >
                    {group.label}
                  </Link>
                ) : (
                  <span className="truncate">{group.label}</span>
                )}
              </div>
              <ul className="flex flex-col gap-0.5">
                {group.threads.map((t) => {
                  const active = t.id === threadId;
                  return (
                    <li key={t.id} className="group relative">
                      <Link
                        to={`/chat/${t.id}`}
                        className={cn(
                          "flex flex-col gap-0.5 rounded-lg px-2.5 py-2 pr-8 transition",
                          active
                            ? "bg-accent/10 text-ink"
                            : "text-ink/80 hover:bg-ink/5 hover:text-ink",
                        )}
                      >
                        <span
                          className={cn(
                            "truncate text-sm leading-snug",
                            active && "font-medium",
                          )}
                        >
                          {t.title || "New chat"}
                        </span>
                        <span className="text-[11px] text-muted">
                          {timeAgo(t.updated_at)}
                        </span>
                      </Link>
                      <div
                        className={cn(
                          "absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100",
                          active && "opacity-100",
                        )}
                      >
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              className="rounded-md p-1 text-muted transition hover:bg-ink/10 hover:text-ink"
                              aria-label="Thread actions"
                            >
                              <MoreHorizontal className="size-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" side="bottom">
                            <DropdownMenuItem
                              className="text-rose-600 focus:text-rose-600 dark:text-rose-400"
                              onSelect={() => void deleteThread(t)}
                            >
                              <Trash2 />
                              Delete chat
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
