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

// Workflow runs are unattended and not resumable (v1): a run left 'running' or
// 'queued' by a dead process is never picked up again (executeWorkflowRun only
// runs 'queued' rows in-process), so it would spin 'Running' forever. On boot,
// fail those runs and error any steps that were mid-flight.
export function startWorkflowRecoverySweep(): number {
  const now = nowISO();
  run(
    `UPDATE workflow_run_steps SET status = 'error', error = 'Interrupted by restart', finished_at = ?
      WHERE status = 'running'`,
    now,
  );
  const res = run(
    `UPDATE workflow_runs
        SET status = 'failed', error = 'Interrupted by restart', finished_at = ?
      WHERE status IN ('running', 'queued')`,
    now,
  );
  const n = Number(res.changes ?? 0);
  if (n > 0) logger.warn({ recovered: n }, "[workflow] marked interrupted runs failed");
  return n;
}
