// SSE client for the chat turn endpoint. Mirrors Flo101's buddy/api.ts
// mechanics: fetch POST, verify text/event-stream, getReader/TextDecoder
// loop splitting frames on \n\n, parse `data:` lines as JSON, skip anything
// malformed. The server's 2KB ":" padding comment and ": ping" heartbeats
// have no `data:` line, so the frame parser drops them naturally.

import { API_BASE } from "@/lib/use-api";
import { getLocalAccessToken } from "@/lib/local-auth";
import { parseApiError } from "@/lib/api-error";
import type { ChatAttachment, Citation, TokenUsage } from "@/lib/types";

export type ChatStreamEvent =
  | { type: "start"; messageId: string }
  | { type: "sources"; citations: Citation[] }
  | { type: "delta"; text: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; threadId: string; messageId: string; text: string; title?: string }
  | { type: "error"; message: string };

export interface StreamChatMessageOptions {
  threadId: string;
  content: string;
  attachments?: ChatAttachment[];
  model?: string;
  signal?: AbortSignal;
  onEvent: (evt: ChatStreamEvent) => void;
}

// Streams one chat turn. Resolves when the stream closes (after done/error
// events have been delivered to onEvent). Throws on network failure, non-OK
// responses, or a non-SSE content type (the JSON error body is surfaced as
// the thrown Error's message).
export async function streamChatMessage({
  threadId,
  content,
  attachments,
  model,
  signal,
  onEvent,
}: StreamChatMessageOptions): Promise<void> {
  const token = await getLocalAccessToken();
  const res = await fetch(`${API_BASE}/api/chat/threads/${threadId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      content,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(model ? { model } : {}),
    }),
    signal,
  });

  const ctype = res.headers.get("content-type") ?? "";
  if (!res.ok || !res.body || !ctype.includes("text/event-stream")) {
    // The endpoint always speaks SSE on success; anything else is an error
    // envelope. Parse it so callers get the clean message.
    const parsed = await parseApiError(res);
    throw new Error(parsed.message || `chat ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        // A frame may contain comment lines (":" padding / ": ping") and/or
        // one data line. Only the data line carries an event.
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as ChatStreamEvent);
        } catch {
          // skip malformed frames
        }
      }
    }
  } finally {
    // Ensure the connection is released even if the caller aborted mid-read.
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
