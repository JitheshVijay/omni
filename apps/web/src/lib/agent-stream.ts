// SSE client + REST helpers for the Super Agent run stream.
//
// The wire mechanics mirror lib/chat/api.ts (fetch + getReader/TextDecoder,
// frames split on \n\n, the server's 2KB ":" pad and ": ping" heartbeats have
// no data line so they drop out) with one addition: the agent stream tags
// persisted frames with an SSE `id: <seq>` line. We track the highest seq so a
// dropped connection can resume with `?after=<lastSeq>` (also sent as the
// Last-Event-ID header) and the server replays only what we missed. `delta`
// and `close` frames carry no id.
//
// A run that suspends (awaiting_confirmation / paused) keeps the same
// connection open — confirming/resuming republishes onto the same in-process
// bus, so no reconnect is needed. We only auto-reconnect on an *unexpected*
// drop while the run is still non-terminal.

import { API_BASE, authFetch } from "@/lib/use-api";
import { getLocalAccessToken } from "@/lib/local-auth";
import { parseApiError } from "@/lib/api-error";
import { isTerminalStatus, type AgentEvent, type AgentRun } from "@/lib/agent-types";

// ── Live stream ─────────────────────────────────────────────────────────────

export type AgentStreamState = "connecting" | "open" | "reconnecting" | "closed";

export interface StreamAgentRunOptions {
  runId: string;
  /** Resume point: only frames with seq > after are delivered. Default 0. */
  after?: number;
  onEvent: (evt: AgentEvent) => void;
  /** Connection lifecycle, for a "reconnecting…" indicator. */
  onConnectionChange?: (state: AgentStreamState) => void;
  /** Fired once when the stream permanently stops (terminal run or stop()). */
  onClosed?: () => void;
}

export interface AgentRunStream {
  start(): void;
  stop(): void;
  /** Highest seq observed so far (for a manual resync). */
  lastSeq(): number;
}

function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 8000);
}

export function streamAgentRun(opts: StreamAgentRunOptions): AgentRunStream {
  let seqSeen = opts.after ?? 0;
  let stopped = false;
  let terminal = false;
  let started = false;
  let attempt = 0;
  let ctrl: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;

  const setState = (s: AgentStreamState) => {
    try {
      opts.onConnectionChange?.(s);
    } catch {
      /* listener threw; ignore */
    }
  };

  function markTerminal(evt: AgentEvent): void {
    if (evt.type === "run_completed" || evt.type === "close") terminal = true;
    else if (evt.type === "run_status" && isTerminalStatus(evt.status)) terminal = true;
  }

  function handleFrame(frame: string): void {
    let dataStr: string | null = null;
    let idStr: string | null = null;
    for (const raw of frame.split("\n")) {
      if (raw.startsWith("data:")) {
        const part = raw.slice(5).replace(/^ /, "");
        dataStr = dataStr === null ? part : `${dataStr}\n${part}`;
      } else if (raw.startsWith("id:")) {
        idStr = raw.slice(3).trim();
      }
      // ":" comment lines (2KB pad / ": ping") ignored.
    }
    if (idStr) {
      const n = Number(idStr);
      if (Number.isFinite(n) && n > seqSeen) seqSeen = n;
    }
    if (dataStr === null) return;
    let evt: AgentEvent;
    try {
      evt = JSON.parse(dataStr) as AgentEvent;
    } catch {
      return; // malformed frame
    }
    const seq = (evt as { seq?: number }).seq;
    if (typeof seq === "number" && seq > seqSeen) seqSeen = seq;
    markTerminal(evt);
    if (evt.type === "close") return; // internal terminal signal, not surfaced
    try {
      opts.onEvent(evt);
    } catch {
      /* consumer threw; keep the stream alive */
    }
  }

  async function connectOnce(): Promise<void> {
    ctrl = new AbortController();
    const token = await getLocalAccessToken();
    const url = `${API_BASE}/api/agent/runs/${encodeURIComponent(
      opts.runId,
    )}/stream?after=${seqSeen}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Last-Event-ID": String(seqSeen),
        Authorization: `Bearer ${token}`,
      },
      signal: ctrl.signal,
    });

    const ctype = res.headers.get("content-type") ?? "";
    if (!res.ok || !res.body || !ctype.includes("text/event-stream")) {
      // Hard error (404/500/…). Surface it and stop — retrying a hard error
      // just loops.
      let message = `stream failed (${res.status})`;
      try {
        message = (await parseApiError(res)).message || message;
      } catch {
        /* non-JSON body */
      }
      terminal = true;
      opts.onEvent({ type: "error", message });
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
        // network error / abort — fall through to the reconnect decision
      }
      if (stopped || terminal) break;
      // Unexpected end while the run is still live → backoff and resume.
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
    lastSeq() {
      return seqSeen;
    },
  };
}

// ── REST helpers ────────────────────────────────────────────────────────────

export interface CreateRunBody {
  goal: string;
  hub_id?: string | null;
  thread_id?: string | null;
  model?: string;
  budget_usd?: number;
}

/** POST /api/agent/runs → the bare created run (status 'queued'). */
export function createRun(body: CreateRunBody): Promise<AgentRun> {
  return authFetch<AgentRun>("/api/agent/runs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface ConfirmCardBody {
  card_id: string;
  action: "confirm" | "skip";
  answer?: string;
}

/** POST /api/agent/runs/:id/confirm — resolve the pending card, resume loop. */
export function confirmCard(runId: string, body: ConfirmCardBody): Promise<unknown> {
  return authFetch(`/api/agent/runs/${runId}/confirm`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** POST /api/agent/runs/:id/cancel — request cancellation. */
export function cancelRun(runId: string): Promise<unknown> {
  return authFetch(`/api/agent/runs/${runId}/cancel`, { method: "POST" });
}

/** POST /api/agent/runs/:id/pause — checkpoint at the next boundary. */
export function pauseRun(runId: string): Promise<unknown> {
  return authFetch(`/api/agent/runs/${runId}/pause`, { method: "POST" });
}

/** POST /api/agent/runs/:id/resume — rehydrate + re-enter the loop
 *  (for paused or failed+resumable runs). */
export function resumeRun(runId: string): Promise<unknown> {
  return authFetch(`/api/agent/runs/${runId}/resume`, { method: "POST" });
}
