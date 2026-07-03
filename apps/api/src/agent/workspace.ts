// Per-run scratch space under ${DATA_DIR}/runs/<runId>/:
//   step-<seq>.txt   tool-result spill when a payload exceeds 64KB
//   workspace/       cwd for run_code (Deno --allow-read/write scope)
// A 24h sweep reclaims dirs for finished runs.
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, logger } from "@omni/sdk";

export const SPILL_THRESHOLD_BYTES = 64 * 1024;

export function runDir(runId: string): string {
  return join(DATA_DIR, "runs", runId);
}

export function workspaceDir(runId: string): string {
  return join(runDir(runId), "workspace");
}

export async function ensureRunDir(runId: string): Promise<string> {
  const dir = runDir(runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function ensureWorkspaceDir(runId: string): Promise<string> {
  const dir = workspaceDir(runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function spillPath(runId: string, seq: number): string {
  return join(runDir(runId), `step-${seq}.txt`);
}

/**
 * Spill a full tool payload to disk when it exceeds the threshold; return
 * the absolute path, or null when the payload is small enough to keep in
 * the step row. Never throws (best-effort durability of the full result).
 */
export async function maybeSpill(
  runId: string,
  seq: number,
  fullContent: string,
): Promise<string | null> {
  if (Buffer.byteLength(fullContent, "utf8") <= SPILL_THRESHOLD_BYTES) return null;
  try {
    await ensureRunDir(runId);
    const path = spillPath(runId, seq);
    await writeFile(path, fullContent, "utf8");
    return path;
  } catch (err) {
    logger.warn({ err, runId, seq }, "[agent] spill write failed");
    return null;
  }
}

/** Files created in the workspace after a run_code invocation (names only). */
export async function listWorkspaceFiles(runId: string): Promise<string[]> {
  const dir = workspaceDir(runId);
  if (!existsSync(dir)) return [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function cleanupRunDir(runId: string): Promise<void> {
  try {
    await rm(runDir(runId), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Delete run dirs whose contents haven't been touched in 24h. */
export async function sweepOldRunDirs(maxAgeMs = SWEEP_MAX_AGE_MS): Promise<number> {
  const base = join(DATA_DIR, "runs");
  if (!existsSync(base)) return 0;
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  try {
    const entries = await readdir(base, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = join(base, e.name);
      try {
        const s = await stat(dir);
        if (s.mtimeMs < cutoff) {
          await rm(dir, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* base gone */
  }
  return removed;
}

/**
 * Start the periodic sweep. Idempotent-ish (returns the timer). The
 * integrator may call this from boot; it also self-starts defensively
 * when the orchestrator first runs.
 */
let sweepTimer: NodeJS.Timeout | null = null;
export function startWorkspaceSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweepOldRunDirs().then((n) => {
      if (n > 0) logger.info({ removed: n }, "[agent] swept old run dirs");
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}
