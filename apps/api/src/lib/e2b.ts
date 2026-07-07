// E2B cloud-sandbox wrapper for the full-stack App Builder. Creates a managed
// VM, writes a generated project into it, installs deps, boots the dev server,
// and exposes a public preview URL. Fail-soft: without E2B_API_KEY every entry
// point throws a clear, actionable error the caller surfaces to the user.
//
// NOTE: the live sandbox path requires E2B_API_KEY (sandboxes are billed), so it
// cannot be exercised in CI — the pure/fail-soft paths are what's unit-tested.
import type { Sandbox as E2BSandbox } from "e2b";
import { env } from "@omni/env-config";
import { logger } from "@omni/sdk";

export function e2bConfigured(): boolean {
  return !!env.E2B_API_KEY;
}

export interface ProjectFile {
  path: string;
  content: string;
}

/** A live sandbox plus the helpers the orchestrator needs. */
export interface SandboxSession {
  id: string;
  /** Public https URL for a port exposed inside the sandbox. */
  previewUrl(port: number): string;
  writeFiles(files: ProjectFile[]): Promise<void>;
  /** Run a command to completion; returns exit code + captured output. */
  exec(
    cmd: string,
    opts?: { cwd?: string; timeoutMs?: number; onLog?: (line: string) => void },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Start a long-running command (dev server) in the background. */
  startBackground(
    cmd: string,
    opts?: { cwd?: string; onLog?: (line: string) => void },
  ): Promise<void>;
  /** Extend the sandbox's auto-shutdown timeout. */
  keepAlive(ms: number): Promise<void>;
  kill(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export async function createSandbox(
  opts: { timeoutMs?: number } = {},
): Promise<SandboxSession> {
  if (!env.E2B_API_KEY) {
    throw new Error(
      "The App Builder needs a cloud sandbox. Add E2B_API_KEY to ~/omni/.env (get one at https://e2b.dev) and restart the API.",
    );
  }
  // Dynamic import so a missing/broken SDK degrades to a clear error rather than
  // crashing the whole API at boot.
  const { Sandbox } = await import("e2b");
  const sandbox = await Sandbox.create({
    apiKey: env.E2B_API_KEY,
    ...(env.E2B_TEMPLATE ? { template: env.E2B_TEMPLATE } : {}),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  logger.info({ sandboxId: sandbox.sandboxId }, "[e2b] sandbox created");
  return wrapSession(sandbox);
}

/** Reconnect to a still-running sandbox for iterative edits; null if it's gone. */
export async function connectSandbox(sandboxId: string): Promise<SandboxSession | null> {
  if (!env.E2B_API_KEY) return null;
  const { Sandbox } = await import("e2b");
  try {
    const sandbox = await Sandbox.connect(sandboxId, { apiKey: env.E2B_API_KEY });
    return wrapSession(sandbox);
  } catch (err) {
    logger.info({ err, sandboxId }, "[e2b] reconnect failed (sandbox likely expired)");
    return null;
  }
}

function wrapSession(sandbox: E2BSandbox): SandboxSession {
  const id = sandbox.sandboxId;
  return {
    id,
    previewUrl: (port) => `https://${sandbox.getHost(port)}`,
    async writeFiles(files) {
      await sandbox.files.write(files.map((f) => ({ path: f.path, data: f.content })));
    },
    async exec(cmd, o = {}) {
      const res = await sandbox.commands.run(cmd, {
        cwd: o.cwd,
        timeoutMs: o.timeoutMs ?? 5 * 60_000,
        onStdout: o.onLog,
        onStderr: o.onLog,
      });
      return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
    },
    async startBackground(cmd, o = {}) {
      // background:true returns immediately with a handle; we don't await it.
      await sandbox.commands.run(cmd, {
        cwd: o.cwd,
        background: true,
        onStdout: o.onLog,
        onStderr: o.onLog,
      });
    },
    async keepAlive(ms) {
      await sandbox.setTimeout(ms);
    },
    async kill() {
      await sandbox.kill().catch((err: unknown) => {
        logger.warn({ err, sandboxId: id }, "[e2b] kill failed");
      });
    },
  };
}
