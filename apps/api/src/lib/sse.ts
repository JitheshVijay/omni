// Server-Sent Events plumbing, generalized from Flo101's buddy.ts/flo.ts
// streaming blocks. One call hijacks the reply, mirrors CORS headers
// (hijacked responses bypass @fastify/cors), defeats proxy buffering with a
// 2KB comment pad, heartbeats every 15s, and hands back send/sendTerminal/
// close helpers plus client-disconnect observation.
import type { FastifyReply, FastifyRequest } from "fastify";

export interface SSEChannel {
  /** Write one `data: {...}` frame. No-op after close. */
  send(event: object): void;
  /** Write one terminal frame; subsequent terminal sends are ignored. */
  sendTerminal(event: object): void;
  /** End the response (idempotent). */
  close(): void;
  /** Register a callback for client disconnect (fires immediately if already gone). */
  onClose(cb: () => void): void;
  /** True once the client disconnected or close() ran. */
  closed: () => boolean;
}

export function openSSE(request: FastifyRequest, reply: FastifyReply): SSEChannel {
  reply.hijack();
  const raw = reply.raw;

  // Hijacked replies skip the CORS plugin's onSend hook — mirror the
  // allow-origin headers manually or the browser drops the stream.
  const origin = request.headers.origin;
  if (origin) {
    raw.setHeader("Access-Control-Allow-Origin", origin);
    raw.setHeader("Vary", "Origin");
    raw.setHeader("Access-Control-Allow-Credentials", "true");
  }
  raw.setHeader("Content-Type", "text/event-stream");
  raw.setHeader("Cache-Control", "no-cache, no-transform");
  raw.setHeader("Connection", "keep-alive");
  raw.setHeader("X-Accel-Buffering", "no");
  raw.flushHeaders();

  // Defeat proxy buffering: many proxies hold responses until ~4KB has been
  // written. SSE ignores `:` comment lines, so the pad is invisible.
  try {
    raw.write(`: ${"-".repeat(2048)}\n\n`);
  } catch {
    /* socket already gone */
  }

  // Heartbeat so clients + proxies don't time out during the latency window
  // before the first token (3-8s on cold paths).
  const heartbeat = setInterval(() => {
    try {
      raw.write(`: ping\n\n`);
    } catch {
      /* socket closed */
    }
  }, 15_000);
  heartbeat.unref?.();

  let clientGone = false;
  let ended = false;
  let terminalSent = false;
  const closeCbs: Array<() => void> = [];

  // Disconnect detection must watch the RESPONSE, not the request stream: for
  // requests with a body, Node destroys the IncomingMessage as soon as the
  // parser drains it, so request.raw "close" fires within milliseconds even
  // though the client is still connected. reply.raw "close" fires only when
  // the underlying connection actually ends (client gone or we end()ed).
  raw.on("close", () => {
    clientGone = true;
    clearInterval(heartbeat);
    for (const cb of closeCbs.splice(0)) {
      try {
        cb();
      } catch {
        /* observer threw; keep tearing down */
      }
    }
  });

  const send = (event: object): void => {
    if (ended) return;
    try {
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      /* socket closed mid-write */
    }
  };

  const sendTerminal = (event: object): void => {
    if (terminalSent) return;
    terminalSent = true;
    send(event);
  };

  const close = (): void => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    try {
      raw.end();
    } catch {
      /* already ended */
    }
  };

  return {
    send,
    sendTerminal,
    close,
    onClose: (cb: () => void) => {
      if (clientGone) {
        try {
          cb();
        } catch {
          /* ignore */
        }
        return;
      }
      closeCbs.push(cb);
    },
    closed: () => clientGone || ended,
  };
}
