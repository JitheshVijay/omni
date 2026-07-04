// Cron triggers for workflows. Schedules are plain node-cron expressions
// persisted on the workflows row; startWorkflowCron() rehydrates every
// enabled schedule at boot (missed-while-down runs are simply missed — no
// catch-up), and syncWorkflowSchedule() re-registers a single workflow after
// create/update/delete. One in-process ScheduledTask per workflow id.
import cron, { type ScheduledTask } from "node-cron";
import { all, logger, nowISO, one, run as dbRun, uuid } from "@omni/sdk";
import { executeWorkflowRun } from "./workflow-runner.js";

interface ScheduledWorkflowRow {
  id: string;
  user_id: string;
  name: string;
  schedule: string | null;
  enabled: number;
}

const tasks = new Map<string, ScheduledTask>();

function tick(workflowId: string): void {
  // Re-read at fire time — the row may have been disabled/deleted since
  // registration (sync keeps the map fresh, but this is the backstop).
  const wf = one<ScheduledWorkflowRow>(
    "SELECT id, user_id, name, schedule, enabled FROM workflows WHERE id = ?",
    workflowId,
  );
  if (!wf || wf.enabled !== 1 || !wf.schedule) return;

  const runId = uuid();
  const now = nowISO();
  dbRun(
    `INSERT INTO workflow_runs (id, workflow_id, user_id, status, trigger, created_at)
     VALUES (?, ?, ?, 'queued', 'cron', ?)`,
    runId,
    wf.id,
    wf.user_id,
    now,
  );
  dbRun("UPDATE workflows SET last_run_at = ? WHERE id = ?", now, wf.id);
  logger.info({ workflowId: wf.id, runId }, "[workflow-cron] triggered run");
  void executeWorkflowRun(runId).catch((err) => {
    logger.error({ err, runId }, "[workflow-cron] executeWorkflowRun crashed");
  });
}

function register(wf: ScheduledWorkflowRow): void {
  if (!wf.schedule || wf.enabled !== 1) return;
  if (!cron.validate(wf.schedule)) {
    logger.warn(
      { workflowId: wf.id, schedule: wf.schedule },
      "[workflow-cron] invalid cron expression; skipping",
    );
    return;
  }
  const task = cron.schedule(wf.schedule, () => {
    try {
      tick(wf.id);
    } catch (err) {
      logger.error({ err, workflowId: wf.id }, "[workflow-cron] tick threw");
    }
  });
  tasks.set(wf.id, task);
}

/** Boot: register every enabled workflow that has a schedule. */
export function startWorkflowCron(): void {
  const rows = all<ScheduledWorkflowRow>(
    "SELECT id, user_id, name, schedule, enabled FROM workflows WHERE schedule IS NOT NULL AND enabled = 1",
  );
  for (const wf of rows) register(wf);
  logger.info({ scheduled: tasks.size }, "[workflow-cron] schedules rehydrated");
}

/**
 * Re-register one workflow's schedule after a create/update. Passing a row
 * with no schedule (or enabled=0) just unschedules it.
 */
export function syncWorkflowSchedule(wf: ScheduledWorkflowRow): void {
  unscheduleWorkflow(wf.id);
  register(wf);
}

/** Drop the in-process task for a deleted workflow. */
export function unscheduleWorkflow(workflowId: string): void {
  const task = tasks.get(workflowId);
  if (task) {
    task.stop();
    tasks.delete(workflowId);
  }
}
