// SSE client for the workflow run stream — a trimmed cousin of
// lib/agent-stream.ts (same fetch + getReader/TextDecoder frame parser as
// lib/chat/api.ts; the server's 2KB ":" pad and ": ping" heartbeats carry no
// data line so they drop out). Workflow steps update in place and the server
// replays every current step row on connect, so reconnects simply replay
// from scratch and the consumer upserts steps by seq — no Last-Event-ID
// bookkeeping needed.

import { API_BASE } from "@/lib/use-api";
import { getLocalAccessToken } from "@/lib/local-auth";
import { parseApiError } from "@/lib/api-error";
import { isTerminalRunStatus, type WorkflowEvent } from "@/lib/workflow-types";

export type WorkflowStreamState = "connecting" | "open" | "reconnecting" | "closed";

export interface StreamWorkflowRunOptions {
  runId: string;
  onEvent: (evt: WorkflowEvent) => void;
  onConnectionChange?: (state: WorkflowStreamState) => void;
  /** Fired once the stream permanently stops (terminal run or stop()). */
  onClosed?: () => void;
}

export interface WorkflowRunStream {
  start(): void;
  stop(): void;
}

function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 8000);
}

export function streamWorkflowRun(opts: StreamWorkflowRunOptions): WorkflowRunStream {
  let stopped = false;
  let terminal = false;
  let started = false;
  let attempt = 0;
  let ctrl: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;

  const setState = (s: WorkflowStreamState) => {
    try {
      opts.onConnectionChange?.(s);
    } catch {
      /* listener threw; ignore */
    }
  };

  function handleFrame(frame: string): void {
    let dataStr: string | null = null;
    for (const raw of frame.split("\n")) {
      if (raw.startsWith("data:")) {
        const part = raw.slice(5).replace(/^ /, "");
        dataStr = dataStr === null ? part : `${dataStr}\n${part}`;
      }
      // "id:" lines and ":" comments (pad / ping) are ignored.
    }
    if (dataStr === null) return;
    let evt: WorkflowEvent;
    try {
      evt = JSON.parse(dataStr) as WorkflowEvent;
    } catch {
      return; // malformed frame
    }
    if (evt.type === "close") {
      terminal = true;
      return; // internal terminal signal, not surfaced
    }
    if (evt.type === "wf_run_status" && isTerminalRunStatus(evt.status)) terminal = true;
    try {
      opts.onEvent(evt);
    } catch {
      /* consumer threw; keep the stream alive */
    }
  }

  async function connectOnce(): Promise<void> {
    ctrl = new AbortController();
    const token = await getLocalAccessToken();
    const url = `${API_BASE}/api/workflows/runs/${encodeURIComponent(opts.runId)}/stream`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });

    const ctype = res.headers.get("content-type") ?? "";
    if (!res.ok || !res.body || !ctype.includes("text/event-stream")) {
      // Hard error (404/500/…) — retrying just loops.
      let message = `stream failed (${res.status})`;
      try {
        message = (await parseApiError(res)).message || message;
      } catch {
        /* non-JSON body */
      }
      terminal = true;
      // Surface as a failed status so consumers show something useful.
      opts.onEvent({
        type: "wf_run_status",
        runId: opts.runId,
        status: "failed",
        cost_usd: 0,
        error: message,
      });
      return;
    }

    setState("open");
    attempt = 0;

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
          handleFrame(frame);
          if (terminal || stopped) {
            try {
              await reader.cancel();
            } catch {
              /* already closed */
            }
            return;
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      wake = resolve;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        wake = null;
        resolve();
      }, ms);
    });
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      setState(attempt === 0 ? "connecting" : "reconnecting");
      try {
        await connectOnce();
      } catch {
        /* network error / abort — fall through to the reconnect decision */
      }
      if (stopped || terminal) break;
      attempt += 1;
      setState("reconnecting");
      await sleep(backoffDelay(attempt));
    }
    setState("closed");
    try {
      opts.onClosed?.();
    } catch {
      /* ignore */
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      void loop();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      ctrl?.abort();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      wake?.();
      wake = null;
    },
  };
}
