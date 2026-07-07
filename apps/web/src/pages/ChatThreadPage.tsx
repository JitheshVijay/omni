// A single conversation: header (title + hub badge + model picker),
// MessageList wired to useChatStream, and the Composer. Handles the
// initial-message-from-router-state handoff from ChatIndexPage exactly once
// (the state is cleared via history replace so a refresh doesn't resend).

import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { FolderKanban, MessageSquareX } from "lucide-react";
import { useApi, authFetch, invalidateApi, invalidateApiPrefix } from "@/lib/use-api";
import { useChatStream } from "@/lib/chat/use-chat-stream";
import type { ChatAttachment, ChatMessage, ChatThread, Hub } from "@/lib/types";
import { MessageList } from "@/components/chat/MessageList";
import { Composer } from "@/components/chat/Composer";
import { ModelPicker } from "@/components/chat/ModelPicker";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import type { ChatNavState } from "@/pages/ChatIndexPage";

// GET /api/chat/threads/:id returns the thread fields flat with `messages`
// attached (same flat convention as the hub detail payload).
type ThreadPayload = ChatThread & { messages: ChatMessage[] };

export default function ChatThreadPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const { data, error: loadError, isInitialLoading } = useApi<ThreadPayload>(
    threadId ? `/api/chat/threads/${threadId}` : null,
  );
  const thread = data ?? null;
  const messages = data?.messages ?? [];

  const {
    send,
    stop,
    isStreaming,
    streamingText,
    streamingCitations,
    pendingUserMessage,
    error: streamError,
  } = useChatStream(threadId ?? null);

  // Optimistic model override so the header chip flips instantly on change.
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  useEffect(() => setModelOverride(null), [threadId]);
  const activeModel = modelOverride ?? thread?.model ?? null;

  // ── Initial message handoff (from ChatIndexPage), exactly once. ──────
  // The send is deferred one tick and the timer is cancelled on cleanup:
  // under StrictMode's throwaway mount the timer never fires (so the stream
  // isn't started-then-aborted), and the surviving mount sends once. The
  // router state is cleared right before sending so refresh/back never
  // resends, and the state-null rerun of this effect is a no-op.
  useEffect(() => {
    const state = location.state as ChatNavState | null;
    if (!threadId || !state?.initialMessage) return;
    const initialMessage = state.initialMessage;
    const attachments = state.attachments;
    const timer = setTimeout(() => {
      navigate(location.pathname, { replace: true, state: null });
      void send(initialMessage, { attachments });
    }, 0);
    return () => clearTimeout(timer);
  }, [threadId, location.state]);

  async function changeModel(modelId: string | null) {
    if (!threadId || !modelId) return;
    setModelOverride(modelId);
    try {
      await authFetch(`/api/chat/threads/${threadId}`, {
        method: "PATCH",
        body: JSON.stringify({ model: modelId }),
      });
      await invalidateApi(`/api/chat/threads/${threadId}`);
      void invalidateApiPrefix("/api/chat/threads");
    } catch {
      setModelOverride(null);
    }
  }

  async function handleSend(content: string, attachments: ChatAttachment[]) {
    await send(content, { attachments });
  }

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <MessageSquareX className="size-10 text-muted/50" />
        <p className="font-display text-lg font-semibold text-ink">
          Couldn't load this chat
        </p>
        <p className="max-w-sm text-sm text-muted">{loadError.message}</p>
        <Button variant="secondary" asChild>
          <Link to="/chat">Back to chats</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-2.5 md:px-6">
        <div className="min-w-0 flex-1 pl-10 lg:pl-0">
          {isInitialLoading ? (
            <Skeleton className="h-5 w-48" />
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate font-display text-sm font-semibold text-ink md:text-base">
                {thread?.title || "New chat"}
              </h1>
              {thread?.hub_id && <HubBadge hubId={thread.hub_id} />}
            </div>
          )}
        </div>
        <ModelPicker
          compact
          value={activeModel}
          onChange={(m) => void changeModel(m)}
          disabled={isStreaming || !thread}
        />
      </header>

      {/* Conversation */}
      {isInitialLoading ? (
        <ThreadSkeleton />
      ) : (
        <MessageList
          messages={messages}
          isStreaming={isStreaming}
          streamingText={streamingText}
          streamingCitations={streamingCitations}
          pendingUserMessage={pendingUserMessage}
          streamError={streamError}
        />
      )}

      <Composer
        onSend={handleSend}
        onStop={stop}
        isStreaming={isStreaming}
        disabled={!thread}
        autoFocus
        modelIndicator={
          activeModel ? (
            <span className="text-[11px] text-muted" title={activeModel}>
              {activeModel.split("/").pop()}
            </span>
          ) : null
        }
      />
    </div>
  );
}

function HubBadge({ hubId }: { hubId: string }) {
  const { data } = useApi<{ hubs: Hub[] }>("/api/hubs");
  const hub = data?.hubs.find((h) => h.id === hubId);
  if (!hub) return null;
  return (
    <Link
      to={`/hubs/${hubId}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-surface2 px-2 py-0.5 text-[11px] text-muted transition hover:border-accent/40 hover:text-accent"
      title={`Hub: ${hub.name}`}
    >
      <FolderKanban className="size-3" />
      <span className="max-w-[120px] truncate">{hub.name}</span>
    </Link>
  );
}

function ThreadSkeleton() {
  return (
    <div className="flex-1 overflow-hidden px-4 py-6 md:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        <div className="flex justify-end">
          <Skeleton className="h-10 w-2/5 rounded-2xl" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-4 w-2/3" />
        </div>
        <div className="flex justify-end">
          <Skeleton className="h-10 w-1/3 rounded-2xl" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
    </div>
  );
}
