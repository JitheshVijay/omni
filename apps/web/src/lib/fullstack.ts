// Client types + SSE helper for the full-stack "App Builder" (/tools/fullstack).
// The build endpoint streams the same wire format as the webapp generator, so
// we reuse the exact `streamSse` reader loop from lib/generate.ts with a
// fullstack-specific event union.

import { streamSse } from "@/lib/generate";
import { authFetch, authFetchRaw } from "@/lib/use-api";
import { parseApiError } from "@/lib/api-error";

// Lifecycle of a build. The five in-flight states drive the progress list;
// the three terminal states decide what the viewer renders.
export type FullstackStatus =
  | "queued"
  | "generating"
  | "provisioning"
  | "installing"
  | "starting"
  | "ready"
  | "failed"
  | "no_sandbox";

// A project row/summary. `preview_url` is a live https origin once `ready`.
export interface FullstackProject {
  id: string;
  name: string;
  summary: string;
  status: FullstackStatus;
  preview_url: string | null;
  sandbox_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface FullstackFile {
  path: string;
  content: string;
}

// GET /api/fullstack/projects/:id returns the flat row plus the file tree.
export interface FullstackProjectDetail extends FullstackProject {
  files: FullstackFile[];
}

// Events emitted by POST /api/fullstack/build (each an SSE `data:` JSON line).
export type FullstackBuildEvent =
  | { type: "created"; id: string }
  | { type: "status"; label: string }
  | { type: "log"; line: string }
  | { type: "project"; project: FullstackProject }
  | { type: "error"; message: string };

// Badge presentation per status (data only; the pages render the <Badge>).
type StatusVariant = "success" | "warning" | "danger" | "secondary";

export const STATUS_META: Record<
  FullstackStatus,
  { label: string; variant: StatusVariant; building: boolean }
> = {
  queued: { label: "Queued", variant: "warning", building: true },
  generating: { label: "Generating", variant: "warning", building: true },
  provisioning: { label: "Provisioning", variant: "warning", building: true },
  installing: { label: "Installing", variant: "warning", building: true },
  starting: { label: "Starting", variant: "warning", building: true },
  ready: { label: "Live", variant: "success", building: false },
  failed: { label: "Failed", variant: "danger", building: false },
  no_sandbox: { label: "No sandbox", variant: "secondary", building: false },
};

export function isBuildingStatus(status: FullstackStatus): boolean {
  return STATUS_META[status]?.building ?? false;
}

/** Run a full-stack build: POST /api/fullstack/build (SSE). */
export function streamFullstackBuild({
  prompt,
  signal,
  onEvent,
}: {
  prompt: string;
  signal?: AbortSignal;
  onEvent: (evt: FullstackBuildEvent) => void;
}) {
  return streamSse<FullstackBuildEvent>({
    path: "/api/fullstack/build",
    body: { prompt },
    signal,
    onEvent,
  });
}

/** Iterative "Edit with AI": POST /api/fullstack/projects/:id/edit (SSE).
 *  Same wire format and reader as streamFullstackBuild, minus the "created"
 *  event: the project's files are updated in place (and, when a live sandbox
 *  exists, hot-applied) so preview_url is unchanged but the app updates. */
export function streamFullstackEdit({
  id,
  instruction,
  signal,
  onEvent,
}: {
  id: string;
  instruction: string;
  signal?: AbortSignal;
  onEvent: (evt: FullstackBuildEvent) => void;
}) {
  return streamSse<FullstackBuildEvent>({
    path: `/api/fullstack/projects/${id}/edit`,
    body: { instruction },
    signal,
    onEvent,
  });
}

// Map a file extension to a CodeBlock `lang` token (it resolves aliases).
export function langForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    css: "css",
    scss: "css",
    html: "html",
    md: "markdown",
    py: "python",
    sql: "sql",
    yml: "yaml",
    yaml: "yaml",
    sh: "bash",
    go: "go",
    rs: "rust",
    java: "java",
    rb: "ruby",
  };
  return map[ext] ?? "text";
}

// Sanitize a project name into a bare (extension-less) download filename.
function safeZipName(name: string): string {
  const base = (name || "app").slice(0, 60).replace(/[^\w\s-]/g, "").trim();
  return base || "app";
}

/** Download the project's source as a .zip.
 *  GET /api/fullstack/projects/:id/export requires the auth Bearer, so a plain
 *  <a href> can't reach it. We fetch it as a blob (authFetchRaw attaches the
 *  header), then synthesize a temporary <a download> click. The server sets the
 *  filename via Content-Disposition; we still pass a sensible download attr. */
export async function exportProjectZip(id: string, name: string): Promise<void> {
  const res = await authFetchRaw(`/api/fullstack/projects/${id}/export`);
  if (!res.ok) throw await parseApiError(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeZipName(name)}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Push the project to GitHub and hand back a Render deploy link.
 *  POST /api/fullstack/projects/:id/deploy. authFetch unwraps the success
 *  envelope; on a failure envelope it throws a ParsedApiError carrying the
 *  `code` ("github_unconfigured" | "deploy_failed" | "empty") and message, so
 *  we let it propagate for the page to branch on. */
export async function deployProject(
  id: string,
): Promise<{ repoUrl: string; renderDeployUrl: string; branch: string }> {
  return authFetch<{ repoUrl: string; renderDeployUrl: string; branch: string }>(
    `/api/fullstack/projects/${id}/deploy`,
    { method: "POST" },
  );
}
