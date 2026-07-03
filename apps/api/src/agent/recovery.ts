// Crash recovery. A run whose loop was executing when the process died is
// left in 'running' or 'planning' with no in-memory AbortController. On boot
// we mark those failed + resumable so the UI offers "Resume" (which
// rehydrates context_snapshot). Runs suspended cleanly
// (awaiting_confirmation / paused) are left as-is — their resume path is the
// confirm / resume endpoint, not this sweep.
import { logger, nowISO, run } from "@omni/sdk";

export function startAgentRecoverySweep(): number {
  const res = run(
    `UPDATE agent_runs
        SET status = 'failed',
            resumable = 1,
            error = 'Interrupted by restart',
            finished_at = ?
      WHERE status IN ('running', 'planning')`,
    nowISO(),
  );
  const n = Number(res.changes ?? 0);
  if (n > 0) logger.warn({ recovered: n }, "[agent] marked interrupted runs failed+resumable");
  return n;
}
