// Orchestrates the full-stack App Builder: codegen -> E2B sandbox -> write
// files -> npm install -> boot the dev server -> public preview URL, persisting
// each transition to app_projects and streaming progress. Fail-soft: without
// E2B_API_KEY it still generates and saves the project (status 'no_sandbox') so
// the user gets the code and a clear "add your key to run it" message.
import { MODELS, all, logger, nowISO, one, run, uuid } from "@omni/sdk";
import { env } from "@omni/env-config";
import {
  connectSandbox,
  createSandbox,
  e2bConfigured,
  type ProjectFile,
  type SandboxSession,
} from "./e2b.js";
import {
  BUILD_CMD,
  DEV_CMD,
  INSTALL_CMD,
  PREVIEW_PORT,
  generateFullstackProject,
  repairFullstackProject,
  reviseFullstackProject,
} from "./fullstack-codegen.js";

const APP_DIR = "/home/user/app";
const SANDBOX_TTL_MS = 20 * 60_000;

// Runtime env injected into the generated app's dev server so it gets REAL AI
// (via server/ai.js) without ever hardcoding a key. The key lives only in the
// sandbox process env — it is never written into the project files, the saved
// row, the export zip, or a deploy. Model names track Omni's own registry.
function aiEnv(): Record<string, string> {
  const vars: Record<string, string> = {
    OMNI_AI_MODEL: MODELS.agent,
    OMNI_AI_VISION_MODEL: MODELS.agent,
  };
  if (env.OPENROUTER_API_KEY) vars.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
  return vars;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A tiny probe script we drop into the sandbox (outside the app dir so Vite
// never bundles it). It GETs each URL passed as an arg and prints one JSON line
// per result; status 0 means the server didn't respond (crashed / not up).
const PROBE_PATH = "/home/user/.omni-probe.mjs";
const PROBE_JS = `const urls = process.argv.slice(2);
for (const u of urls) {
  try {
    const r = await fetch(u, { method: "GET", signal: AbortSignal.timeout(8000) });
    let body = "";
    if (r.status >= 500) { body = (await r.text().catch(() => "")).slice(0, 400).replace(/\\s+/g, " "); }
    console.log(JSON.stringify({ url: u, status: r.status, body }));
  } catch (e) {
    console.log(JSON.stringify({ url: u, status: 0, err: String((e && e.message) || e).slice(0, 200) }));
  }
}
`;

interface ProbeResult {
  url: string;
  status: number;
  body?: string;
  err?: string;
}

/** Run the probe script against a set of URLs from inside the sandbox. */
async function probeUrls(box: SandboxSession, urls: string[]): Promise<ProbeResult[]> {
  const res = await box.exec(`node ${PROBE_PATH} ${urls.join(" ")}`, { timeoutMs: 30_000 });
  const out: ProbeResult[] = [];
  for (const line of res.stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t) as ProbeResult);
    } catch {
      /* ignore non-JSON log noise */
    }
  }
  return out;
}

/** Poll until both the Vite dev server (5173) and the Express API (3001) answer,
 *  or the timeout elapses. "Up" = any HTTP response (a 404 still means alive). */
async function waitReady(
  box: SandboxSession,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ frontendUp: boolean; backendUp: boolean }> {
  const start = Date.now();
  let frontendUp = false;
  let backendUp = false;
  while (Date.now() - start < timeoutMs) {
    if (signal.aborted) throw new Error("aborted");
    const res = await probeUrls(box, ["http://localhost:5173/", "http://localhost:3001/"]);
    frontendUp = res.some((r) => r.url.includes("5173") && r.status > 0);
    backendUp = res.some((r) => r.url.includes("3001") && r.status > 0);
    if (frontendUp && backendUp) return { frontendUp, backendUp };
    await sleep(3000);
  }
  return { frontendUp, backendUp };
}

/** Parameter-free GET /api routes from the server, for smoke probing. */
function apiGetRoutes(files: ProjectFile[]): string[] {
  const server = files.find((f) => f.path === "server/index.js")?.content ?? "";
  const set = new Set<string>();
  for (const m of server.matchAll(/app\.get\(\s*['"`](\/api\/[^'"`?\s]+)['"`]/g)) {
    if (!m[1].includes(":")) set.add(m[1]);
  }
  return [...set].slice(0, 6);
}

function logTail(logBuf: string[]): string {
  return logBuf.slice(-40).join("\n").slice(-2000);
}

export type BuildEvent =
  | { type: "status"; label: string }
  | { type: "log"; line: string }
  | { type: "project"; project: AppProjectSummary }
  | { type: "error"; message: string };

export interface AppProjectRow {
  id: string;
  user_id: string;
  name: string;
  prompt: string;
  summary: string | null;
  files: string;
  sandbox_id: string | null;
  preview_url: string | null;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppProjectSummary {
  id: string;
  name: string;
  summary: string | null;
  status: string;
  preview_url: string | null;
  sandbox_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function toSummary(r: AppProjectRow): AppProjectSummary {
  return {
    id: r.id,
    name: r.name,
    summary: r.summary,
    status: r.status,
    preview_url: r.preview_url,
    sandbox_id: r.sandbox_id,
    error: r.error,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function patch(id: string, fields: Partial<AppProjectRow>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = ?`).join(", ");
  run(
    `UPDATE app_projects SET ${set}, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => (fields as Record<string, unknown>)[k]),
    nowISO(),
    id,
  );
}

export function createProjectRow(userId: string, prompt: string): AppProjectRow {
  const id = uuid();
  run(
    `INSERT INTO app_projects (id, user_id, name, prompt, status) VALUES (?, ?, ?, ?, 'queued')`,
    id,
    userId,
    "New app",
    prompt,
  );
  return one<AppProjectRow>("SELECT * FROM app_projects WHERE id = ?", id)!;
}

export function getProject(userId: string, id: string): AppProjectRow | undefined {
  return one<AppProjectRow>(
    "SELECT * FROM app_projects WHERE id = ? AND user_id = ?",
    id,
    userId,
  );
}

export function listProjects(userId: string): AppProjectSummary[] {
  return all<AppProjectRow>(
    "SELECT * FROM app_projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100",
    userId,
  ).map(toSummary);
}

/** Run the full build pipeline for an existing (queued) project row. */
export async function buildApp(
  projectId: string,
  userId: string,
  emit: (e: BuildEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const row = getProject(userId, projectId);
  if (!row) {
    emit({ type: "error", message: "Project not found." });
    return;
  }

  try {
    // 1) Codegen — the part that works without a sandbox.
    emit({ type: "status", label: "Designing the app…" });
    patch(projectId, { status: "generating" });
    const project = await generateFullstackProject(row.prompt);
    if (signal.aborted) throw new Error("aborted");
    patch(projectId, {
      name: project.name,
      summary: project.summary,
      files: JSON.stringify(project.files),
    });
    emit({ type: "status", label: `Generated ${project.files.length} files` });

    // 2) No sandbox key -> stop here with the code saved.
    if (!e2bConfigured()) {
      patch(projectId, {
        status: "no_sandbox",
        error: "Add E2B_API_KEY to run this app in a live sandbox.",
      });
      emit({
        type: "status",
        label: "Code generated. Add E2B_API_KEY (e2b.dev) and restart the API to run it live.",
      });
      emit({ type: "project", project: toSummary(getProject(userId, projectId)!) });
      return;
    }

    // 3) Provision a sandbox, install, and boot the dev server -> preview URL.
    await provisionAndRun(projectId, userId, project.files, emit, signal);
  } catch (err) {
    const message = (err as Error).message || "Build failed";
    logger.warn({ err, projectId }, "[app-builder] build failed");
    patch(projectId, { status: "failed", error: message.slice(0, 1000) });
    emit({ type: "error", message });
    emit({ type: "project", project: toSummary(getProject(userId, projectId)!) });
  }
}

/** After install, build the frontend and syntax-check the backend; if either
 *  fails, ask the model to fix it and retry (bounded). Best-effort: if it still
 *  fails we boot anyway (Vite shows an error overlay, not a blank screen), and
 *  every fix is persisted so the saved project reflects the repaired code. */
async function verifyAndRepair(
  box: SandboxSession,
  projectId: string,
  files: ProjectFile[],
  emit: (e: BuildEvent) => void,
  signal: AbortSignal,
): Promise<ProjectFile[]> {
  const MAX_REPAIRS = 2;
  let current = files;
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    if (signal.aborted) throw new Error("aborted");
    emit({
      type: "status",
      label: attempt === 0 ? "Checking the build…" : `Fixing build issues (attempt ${attempt})…`,
    });

    const build = await box.exec(BUILD_CMD, {
      cwd: APP_DIR,
      timeoutMs: 3 * 60_000,
      onLog: (line) => emit({ type: "log", line: line.slice(0, 500) }),
    });
    const backend = await box.exec("node --check server/index.js", {
      cwd: APP_DIR,
      timeoutMs: 30_000,
    });

    const problems: string[] = [];
    if (build.exitCode !== 0) {
      problems.push(`Frontend build (vite build) failed:\n${(build.stderr || build.stdout).slice(-3000)}`);
    }
    if (backend.exitCode !== 0) {
      problems.push(`Backend server/index.js failed node --check:\n${(backend.stderr || backend.stdout).slice(-1500)}`);
    }

    if (problems.length === 0) {
      emit({ type: "status", label: "Build passed." });
      return current;
    }
    if (attempt === MAX_REPAIRS) {
      emit({ type: "log", line: "Build still has issues after repair attempts; starting anyway." });
      return current;
    }

    const { changedFiles } = await repairFullstackProject(current, problems.join("\n\n"));
    if (changedFiles.length === 0) {
      emit({ type: "log", line: "No automatic fix produced; starting anyway." });
      return current;
    }
    current = mergeFiles(current, changedFiles);
    patch(projectId, { files: JSON.stringify(current) });
    await box.writeFiles(
      changedFiles.map((f) => ({ path: `${APP_DIR}/${f.path}`, content: f.content })),
    );
    emit({ type: "status", label: `Applied ${changedFiles.length} fix(es)` });
  }
  return current;
}

/** After the dev server boots, verify the app actually RUNS: wait for both
 *  servers to answer, probe the app's own GET /api routes for crashes/500s, and
 *  if anything is broken feed the failures + server logs to the repair model and
 *  hot-reload the fix. Catches what a build check can't (server crash on start,
 *  bad SQL, 500ing endpoints). Best-effort and self-contained: it never throws
 *  the build — worst case it opens the preview as-is. */
async function smokeTest(
  box: SandboxSession,
  projectId: string,
  files: ProjectFile[],
  logBuf: string[],
  emit: (e: BuildEvent) => void,
  signal: AbortSignal,
): Promise<ProjectFile[]> {
  const MAX_REPAIRS = 2;
  let current = files;
  try {
    await box.writeFiles([{ path: PROBE_PATH, content: PROBE_JS }]);
    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      if (signal.aborted) throw new Error("aborted");
      emit({
        type: "status",
        label: attempt === 0 ? "Smoke-testing the app…" : `Fixing runtime issues (attempt ${attempt})…`,
      });

      const { backendUp } = await waitReady(box, attempt === 0 ? 60_000 : 30_000, signal);
      const routes = apiGetRoutes(current);
      const probes =
        backendUp && routes.length
          ? await probeUrls(box, routes.map((r) => `http://localhost:3001${r}`))
          : [];

      const problems: string[] = [];
      if (!backendUp) {
        problems.push(
          "The backend Express server on port 3001 is not responding — it likely threw on startup (bad SQL in a CREATE TABLE, a better-sqlite3 misuse, or an uncaught error). Fix server/index.js so it boots and listens.",
        );
      }
      for (const p of probes) {
        if (p.status === 0) {
          problems.push(`GET ${p.url} did not respond (${p.err ?? "no response"}). The server may have crashed handling it.`);
        } else if (p.status >= 500) {
          problems.push(`GET ${p.url} returned HTTP ${p.status}. Response: ${p.body ?? ""}`);
        }
      }

      if (problems.length === 0) {
        emit({ type: "status", label: "Smoke test passed." });
        return current;
      }
      if (attempt === MAX_REPAIRS) {
        emit({ type: "log", line: "Runtime issues remain after repair; opening the preview as-is." });
        return current;
      }

      const report = `${problems.join("\n\n")}\n\nRecent dev-server logs:\n${logTail(logBuf)}`;
      const { changedFiles } = await repairFullstackProject(current, report);
      if (changedFiles.length === 0) {
        emit({ type: "log", line: "No automatic runtime fix produced; opening the preview as-is." });
        return current;
      }
      current = mergeFiles(current, changedFiles);
      patch(projectId, { files: JSON.stringify(current) });
      await box.writeFiles(
        changedFiles.map((f) => ({ path: `${APP_DIR}/${f.path}`, content: f.content })),
      );
      emit({ type: "status", label: `Applied ${changedFiles.length} runtime fix(es)` });
      // Give node --watch (backend) and Vite HMR (frontend) time to reload.
      await sleep(5000);
    }
    return current;
  } catch (err) {
    // Never let smoke-test infrastructure failures fail an otherwise-fine build.
    if ((err as Error).message === "aborted") throw err;
    emit({ type: "log", line: `Smoke test skipped: ${(err as Error).message}` });
    return current;
  }
}

/** Create a fresh sandbox, load ALL files, install, and boot the dev server. */
async function provisionAndRun(
  projectId: string,
  userId: string,
  files: ProjectFile[],
  emit: (e: BuildEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  emit({ type: "status", label: "Provisioning cloud sandbox…" });
  patch(projectId, { status: "provisioning" });
  const box = await createSandbox({ timeoutMs: SANDBOX_TTL_MS });
  patch(projectId, { sandbox_id: box.id });
  await box.writeFiles(files.map((f) => ({ path: `${APP_DIR}/${f.path}`, content: f.content })));

  emit({ type: "status", label: "Installing dependencies…" });
  patch(projectId, { status: "installing" });
  const install = await box.exec(INSTALL_CMD, {
    cwd: APP_DIR,
    timeoutMs: 6 * 60_000,
    onLog: (line) => emit({ type: "log", line: line.slice(0, 500) }),
  });
  if (signal.aborted) throw new Error("aborted");
  if (install.exitCode !== 0) {
    throw new Error(`Dependency install failed (exit ${install.exitCode}). ${install.stderr.slice(-400)}`);
  }

  // Verify the app actually builds, and self-repair if it doesn't, before we
  // boot it — otherwise a first-shot bug ships as a blank preview.
  const built = await verifyAndRepair(box, projectId, files, emit, signal);

  emit({ type: "status", label: "Starting the dev server…" });
  patch(projectId, { status: "starting" });
  // Keep a rolling buffer of dev-server output so the smoke test can hand the
  // repair model real stack traces when something crashes at runtime.
  const logBuf: string[] = [];
  await box.startBackground(DEV_CMD, {
    cwd: APP_DIR,
    env: aiEnv(),
    onLog: (line) => {
      logBuf.push(line);
      if (logBuf.length > 400) logBuf.splice(0, logBuf.length - 400);
      emit({ type: "log", line: line.slice(0, 500) });
    },
  });

  // Confirm the app actually RUNS (and self-repair runtime crashes / 500s)
  // before we hand back a preview URL.
  await smokeTest(box, projectId, built, logBuf, emit, signal);

  await box.keepAlive(SANDBOX_TTL_MS);
  const previewUrl = box.previewUrl(PREVIEW_PORT);
  patch(projectId, { status: "ready", preview_url: previewUrl, error: null });
  emit({ type: "status", label: "Live." });
  emit({ type: "project", project: toSummary(getProject(userId, projectId)!) });
  logger.info({ projectId, sandboxId: box.id, previewUrl }, "[app-builder] ready");
}

function mergeFiles(current: ProjectFile[], changed: ProjectFile[]): ProjectFile[] {
  const byPath = new Map(current.map((f) => [f.path, f]));
  for (const f of changed) byPath.set(f.path, f);
  return [...byPath.values()];
}

/** Apply a natural-language change: revise code, then hot-apply to the live
 *  sandbox (reconnect + write only changed files), rebuilding if it expired. */
export async function editApp(
  projectId: string,
  userId: string,
  instruction: string,
  emit: (e: BuildEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const row = getProject(userId, projectId);
  if (!row) {
    emit({ type: "error", message: "Project not found." });
    return;
  }
  let currentFiles: ProjectFile[];
  try {
    currentFiles = JSON.parse(row.files) as ProjectFile[];
  } catch {
    currentFiles = [];
  }
  if (currentFiles.length === 0) {
    emit({ type: "error", message: "This project has no code yet. Build it first." });
    return;
  }

  try {
    emit({ type: "status", label: "Planning the change…" });
    const { changedFiles, deletedPaths, summary } = await reviseFullstackProject(
      currentFiles,
      instruction,
    );
    if (signal.aborted) throw new Error("aborted");
    if (changedFiles.length === 0 && deletedPaths.length === 0) {
      emit({ type: "status", label: "No file changes were needed." });
      emit({ type: "project", project: toSummary(getProject(userId, projectId)!) });
      return;
    }
    let merged = mergeFiles(currentFiles, changedFiles);
    if (deletedPaths.length) merged = merged.filter((f) => !deletedPaths.includes(f.path));
    patch(projectId, { files: JSON.stringify(merged), summary });
    emit({ type: "status", label: `Updated ${changedFiles.length + deletedPaths.length} file(s)` });

    if (!e2bConfigured()) {
      patch(projectId, { status: "no_sandbox" });
      emit({ type: "status", label: "Saved. Add E2B_API_KEY to run it live." });
      emit({ type: "project", project: toSummary(getProject(userId, projectId)!) });
      return;
    }

    // Reconnect to the running sandbox and hot-apply ONLY the changed files —
    // Vite HMR (frontend) and node --watch (backend) pick them up in place.
    const box = row.sandbox_id ? await connectSandbox(row.sandbox_id) : null;
    if (box) {
      emit({ type: "status", label: "Applying to the live sandbox…" });
      if (changedFiles.length) {
        await box.writeFiles(
          changedFiles.map((f) => ({ path: `${APP_DIR}/${f.path}`, content: f.content })),
        );
      }
      for (const p of deletedPaths) {
        await box.exec(`rm -f "${APP_DIR}/${p}"`, { cwd: APP_DIR }).catch(() => undefined);
      }
      await box.keepAlive(SANDBOX_TTL_MS);
      patch(projectId, { status: "ready", error: null });
      emit({ type: "status", label: "Live." });
      emit({ type: "project", project: toSummary(getProject(userId, projectId)!) });
      return;
    }

    // Sandbox expired -> rebuild it from the merged files.
    emit({ type: "status", label: "Sandbox expired; restarting it…" });
    await provisionAndRun(projectId, userId, merged, emit, signal);
  } catch (err) {
    const message = (err as Error).message || "Edit failed";
    logger.warn({ err, projectId }, "[app-builder] edit failed");
    patch(projectId, { status: "failed", error: message.slice(0, 1000) });
    emit({ type: "error", message });
    emit({ type: "project", project: toSummary(getProject(userId, projectId)!) });
  }
}
