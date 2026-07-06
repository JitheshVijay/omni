// SSE client for the generator run + revise endpoints. Same wire mechanics
// as lib/chat/api.ts (fetch POST, verify text/event-stream, getReader +
// TextDecoder loop splitting frames on \n\n, parse `data:` lines as JSON):
// the server's 2KB ":" padding and ": ping" heartbeats carry no data line,
// so the frame parser drops them naturally.
//
// Event contract (POST /api/generate/:name and /api/artifacts/:id/revise):
//   {type:"status",  label}                       — human progress, 0..n
//   {type:"delta",   channel:"markdown", data}    — doc only: streamed text
//   {type:"artifact",artifact: ArtifactSummary}   — terminal success
//   {type:"error",   message}                     — terminal failure
//
// Invalid input returns JSON 400 BEFORE the hijack — surfaced here as a
// thrown GenerateRequestError carrying the parsed envelope (message/status/
// code), so form UIs can show the clean Zod message.

import { API_BASE } from "@/lib/use-api";
import { getLocalAccessToken } from "@/lib/local-auth";
import { parseApiError, type ParsedApiError } from "@/lib/api-error";
import type { ArtifactSummary } from "@/lib/types";

export type GeneratorName =
  | "doc"
  | "image"
  | "tts"
  | "slides"
  | "sheet"
  | "podcast"
  | "webapp";

export type GenerateEvent =
  | { type: "status"; label: string }
  | { type: "delta"; channel: string; data: string }
  | { type: "artifact"; artifact: ArtifactSummary }
  | { type: "error"; message: string };

// ParsedApiError as a throwable — instanceof-checkable and still matching
// the {message, status, code} shape every error UI in the app expects.
export class GenerateRequestError extends Error implements ParsedApiError {
  status: number;
  code: string | null;
  constructor(parsed: ParsedApiError) {
    super(parsed.message);
    this.name = "GenerateRequestError";
    this.status = parsed.status;
    this.code = parsed.code;
  }
}

interface StreamSseOptions {
  path: string;
  body: unknown;
  signal?: AbortSignal;
  onEvent: (evt: GenerateEvent) => void;
}

// Resolves when the stream closes (after artifact/error events have been
// delivered). Throws GenerateRequestError on a non-SSE response (400/404),
// and rethrows AbortError if the caller cancels.
async function streamSse({ path, body, signal, onEvent }: StreamSseOptions): Promise<void> {
  const token = await getLocalAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body ?? {}),
    signal,
  });

  const ctype = res.headers.get("content-type") ?? "";
  if (!res.ok || !res.body || !ctype.includes("text/event-stream")) {
    throw new GenerateRequestError(await parseApiError(res));
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
          onEvent(JSON.parse(line.slice(5).trim()) as GenerateEvent);
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

export interface StreamGenerateOptions {
  name: GeneratorName | string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  onEvent: (evt: GenerateEvent) => void;
}

/** Run a registered generator: POST /api/generate/:name (SSE). */
export function streamGenerate({ name, body, signal, onEvent }: StreamGenerateOptions) {
  return streamSse({ path: `/api/generate/${name}`, body, signal, onEvent });
}

export interface StreamReviseOptions {
  artifactId: string;
  instruction: string;
  signal?: AbortSignal;
  onEvent: (evt: GenerateEvent) => void;
}

/** "Edit with AI": POST /api/artifacts/:id/revise (same SSE contract).
 *  Produces a NEW artifact with parent_id = artifactId. */
export function streamRevise({ artifactId, instruction, signal, onEvent }: StreamReviseOptions) {
  return streamSse({
    path: `/api/artifacts/${artifactId}/revise`,
    body: { instruction },
    signal,
    onEvent,
  });
}
