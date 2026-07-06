// SSE client for the Deep Research endpoint. Mirrors chat/api.ts mechanics:
// fetch POST, verify text/event-stream, getReader/TextDecoder loop splitting
// frames on \n\n, parse `data:` lines as JSON, skip anything malformed. The
// server's 2KB ":" padding and ": ping" heartbeats have no `data:` line so
// the frame parser drops them naturally.

import { API_BASE } from "@/lib/use-api";
import { getLocalAccessToken } from "@/lib/local-auth";
import { parseApiError } from "@/lib/api-error";
import type { ArtifactSummary } from "@/lib/types";

export type ResearchStreamEvent =
  | { type: "status"; label: string }
  | { type: "delta"; channel: string; data: unknown }
  | { type: "artifact"; artifact: ArtifactSummary }
  | { type: "error"; message: string };

export interface StreamResearchOptions {
  question: string;
  signal?: AbortSignal;
  onEvent: (evt: ResearchStreamEvent) => void;
}

// Streams one research run. Resolves when the stream closes (after the
// terminal artifact/error event has been delivered). Throws on network
// failure, non-OK responses, or a non-SSE content type (the JSON error body
// is surfaced as the thrown Error's message).
export async function streamResearch({
  question,
  signal,
  onEvent,
}: StreamResearchOptions): Promise<void> {
  const token = await getLocalAccessToken();
  const res = await fetch(`${API_BASE}/api/research`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ question }),
    signal,
  });

  const ctype = res.headers.get("content-type") ?? "";
  if (!res.ok || !res.body || !ctype.includes("text/event-stream")) {
    const parsed = await parseApiError(res);
    throw new Error(parsed.message || `research ${res.status}`);
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
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as ResearchStreamEvent);
        } catch {
          // skip malformed frames
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
