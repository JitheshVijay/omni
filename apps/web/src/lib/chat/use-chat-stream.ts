// Chat streaming state machine for a single thread. Owns the in-flight SSE
// turn: the optimistic user bubble, the accumulating assistant draft, hub
// citations, usage, and the AbortController. On done it revalidates the
// thread (messages now persisted server-side) and the thread list (title /
// updated_at bumps), and only THEN clears the draft state — so the finished
// reply never flickers out before the persisted copy arrives.

import { useCallback, useEffect, useRef, useState } from "react";
import { streamChatMessage, type ChatStreamEvent } from "@/lib/chat/api";
import { invalidateApi, invalidateApiPrefix } from "@/lib/use-api";
import type { ChatAttachment, Citation, TokenUsage } from "@/lib/types";

export interface PendingUserMessage {
  content: string;
  attachments: ChatAttachment[];
}

export interface SendOptions {
  attachments?: ChatAttachment[];
  model?: string;
}

export interface ChatStreamState {
  send: (content: string, opts?: SendOptions) => Promise<void>;
  stop: () => void;
  isStreaming: boolean;
  streamingText: string;
  streamingCitations: Citation[];
  streamingUsage: TokenUsage | null;
  streamingMessageId: string | null;
  pendingUserMessage: PendingUserMessage | null;
  error: string | null;
}

export function useChatStream(threadId: string | null): ChatStreamState {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingCitations, setStreamingCitations] = useState<Citation[]>([]);
  const [streamingUsage, setStreamingUsage] = useState<TokenUsage | null>(null);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [pendingUserMessage, setPendingUserMessage] = useState<PendingUserMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Accumulate deltas in a ref and mirror into state — avoids stale-closure
  // appends if React batches multiple deltas into one render.
  const textRef = useRef("");

  const resetDraft = useCallback(() => {
    textRef.current = "";
    setStreamingText("");
    setStreamingCitations([]);
    setStreamingUsage(null);
    setStreamingMessageId(null);
    setPendingUserMessage(null);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Abort on unmount and whenever the thread changes out from under us.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [threadId]);

  const send = useCallback(
    async (content: string, opts?: SendOptions) => {
      const trimmed = content.trim();
      if (!threadId || !trimmed || abortRef.current) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setIsStreaming(true);
      textRef.current = "";
      setStreamingText("");
      setStreamingCitations([]);
      setStreamingUsage(null);
      setStreamingMessageId(null);
      setPendingUserMessage({ content: trimmed, attachments: opts?.attachments ?? [] });

      let streamError: string | null = null;

      const onEvent = (evt: ChatStreamEvent) => {
        switch (evt.type) {
          case "start":
            setStreamingMessageId(evt.messageId);
            break;
          case "sources":
            setStreamingCitations(evt.citations ?? []);
            break;
          case "delta":
            textRef.current += evt.text;
            setStreamingText(textRef.current);
            break;
          case "usage":
            setStreamingUsage(evt.usage);
            break;
          case "done":
            // Revalidation happens after the read loop closes (below).
            break;
          case "error":
            streamError = evt.message || "Something went wrong.";
            break;
        }
      };

      try {
        await streamChatMessage({
          threadId,
          content: trimmed,
          attachments: opts?.attachments,
          model: opts?.model,
          signal: controller.signal,
          onEvent,
        });
      } catch (err) {
        const aborted =
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === "AbortError");
        if (!aborted) {
          streamError = err instanceof Error ? err.message : String(err);
        }
      } finally {
        abortRef.current = null;
      }

      if (streamError) setError(streamError);

      // Pull the persisted rows (user turn + assistant turn + title bump)
      // BEFORE clearing the optimistic draft so there's no gap where the
      // conversation appears to lose its last exchange. Await resolves after
      // SWR revalidation completes.
      try {
        await Promise.all([
          invalidateApi(`/api/chat/threads/${threadId}`),
          invalidateApiPrefix(`/api/chat/threads`),
        ]);
      } catch {
        // Revalidation failures surface through SWR's own error channel.
      }

      resetDraft();
      setIsStreaming(false);
    },
    [threadId, resetDraft],
  );

  return {
    send,
    stop,
    isStreaming,
    streamingText,
    streamingCitations,
    streamingUsage,
    streamingMessageId,
    pendingUserMessage,
    error,
  };
}
