// Orchestrates the full-stack App Builder: codegen -> E2B sandbox -> write
// files -> npm install -> boot the dev server -> public preview URL, persisting
// each transition to app_projects and streaming progress. Fail-soft: without
// E2B_API_KEY it still generates and saves the project (status 'no_sandbox') so
// the user gets the code and a clear "add your key to run it" message.
import { all, logger, nowISO, one, run, uuid } from "@omni/sdk";
import { connectSandbox, createSandbox, e2bConfigured, type ProjectFile } from "./e2b.js";
import {
  DEV_CMD,
  INSTALL_CMD,
  PREVIEW_PORT,
  generateFullstackProject,
  reviseFullstackProject,
} from "./fullstack-codegen.js";

const APP_DIR = "/home/user/app";
const SANDBOX_TTL_MS = 20 * 60_000;

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

  emit({ type: "status", label: "Starting the dev server…" });
  patch(projectId, { status: "starting" });
  await box.startBackground(DEV_CMD, {
    cwd: APP_DIR,
    onLog: (line) => emit({ type: "log", line: line.slice(0, 500) }),
  });
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
    const { changedFiles, summary } = await reviseFullstackProject(currentFiles, instruction);
    if (signal.aborted) throw new Error("aborted");
    if (changedFiles.length === 0) {
      emit({ type: "status", label: "No file changes were needed." });
      emit({ type: "project", project: toSummary(getProject(userId, projectId)!) });
      return;
    }
    const merged = mergeFiles(currentFiles, changedFiles);
    patch(projectId, { files: JSON.stringify(merged), summary });
    emit({ type: "status", label: `Updated ${changedFiles.length} file(s)` });

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
      await box.writeFiles(
        changedFiles.map((f) => ({ path: `${APP_DIR}/${f.path}`, content: f.content })),
      );
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
