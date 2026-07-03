// In-process pub/sub for agent run events, keyed by runId. The SSE stream
// endpoint subscribes here FIRST, then replays persisted steps, then live-
// tails (deduping by seq) — so no event emitted between subscribe and
// replay is lost. Events published here are the exact SSE payloads the
// client receives (see the agent SSE protocol).
//
// Nothing here is durable: the durable record is agent_steps (seq =
// SSE id). The bus is a low-latency fan-out for currently-connected
// listeners only.

export type AgentEvent = Record<string, unknown> & { type: string; seq?: number };

type Listener = (event: AgentEvent) => void;

const buses = new Map<string, Set<Listener>>();

/** Subscribe to a run's live events. Returns an unsubscribe function. */
export function subscribe(runId: string, cb: Listener): () => void {
  let set = buses.get(runId);
  if (!set) {
    set = new Set();
    buses.set(runId, set);
  }
  set.add(cb);
  return () => {
    const s = buses.get(runId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) buses.delete(runId);
  };
}

/** Publish one event to every current subscriber of a run. Never throws. */
export function publish(runId: string, event: AgentEvent): void {
  const set = buses.get(runId);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb(event);
    } catch {
      /* a listener threw; keep fanning out to the rest */
    }
  }
}

/** True when at least one client is currently tailing this run. */
export function hasSubscribers(runId: string): boolean {
  const set = buses.get(runId);
  return !!set && set.size > 0;
}
