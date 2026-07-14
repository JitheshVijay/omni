// Full-stack App Builder routes: generate a multi-file app, run it in an E2B
// sandbox, and stream progress. Falls back to codegen-only (status 'no_sandbox')
// when E2B_API_KEY is absent — the request still succeeds with the saved code.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { openSSE } from "../lib/sse.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  buildApp,
  createProjectRow,
  editApp,
  getProject,
  listProjects,
  type BuildEvent,
} from "../lib/app-builder.js";

import { zipName, zipProject } from "../lib/project-export.js";
import { deployProject, githubConfigured } from "../lib/deploy.js";
import type { ProjectFile } from "../lib/e2b.js";

const BuildSchema = z.object({ prompt: z.string().min(1).max(4000) });
const EditSchema = z.object({ instruction: z.string().min(1).max(4000) });

// A generate/edit runs server-side for minutes; it must survive a dropped SSE
// client (closed tab, network blip) rather than being aborted with it. Only this
// hard backstop aborts a genuinely runaway build.
const BUILD_TIMEOUT_MS = 20 * 60_000;

function projectFiles(filesJson: string): ProjectFile[] {
  try {
    return JSON.parse(filesJson) as ProjectFile[];
  } catch {
    return [];
  }
}

export async function fullstackRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/fullstack/projects", async (request) => {
    return { success: true, data: { projects: listProjects((request as AuthenticatedRequest).userId) } };
  });

  app.get("/api/fullstack/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getProject((request as AuthenticatedRequest).userId, id);
    if (!row) {
      return reply
        .status(404)
        .send({ success: false, error: "Project not found", code: "not_found" });
    }
    let files: unknown;
    try {
      files = JSON.parse(row.files);
    } catch {
      files = [];
    }
    return { success: true, data: { ...row, files } };
  });

  // SSE: create a project and stream the build. Validate before hijacking so a
  // bad body still gets a plain JSON 400.
  app.post("/api/fullstack/build", async (request, reply) => {
    const parsed = BuildSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const project = createProjectRow((request as AuthenticatedRequest).userId, parsed.data.prompt);
    const sse = openSSE(request, reply);
    // NOTE: deliberately NOT aborting on client disconnect — the build keeps
    // running and the project row records the final status to poll/refresh.
    const ac = new AbortController();
    const backstop = setTimeout(() => ac.abort(), BUILD_TIMEOUT_MS);
    backstop.unref?.();
    // Tell the client the id immediately so it can navigate/poll if it wants.
    sse.send({ type: "created", id: project.id });
    try {
      await buildApp(project.id, (request as AuthenticatedRequest).userId, (e: BuildEvent) => sse.send(e), ac.signal);
    } catch (err) {
      sse.send({ type: "error", message: (err as Error).message });
    } finally {
      clearTimeout(backstop);
    }
    sse.close();
  });

  // SSE: apply a natural-language edit to an existing project.
  app.post("/api/fullstack/projects/:id/edit", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = EditSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const userId = (request as AuthenticatedRequest).userId;
    if (!getProject(userId, id)) {
      return reply.status(404).send({ success: false, error: "Project not found", code: "not_found" });
    }
    const sse = openSSE(request, reply);
    // Same as build: survive client disconnect; only the backstop aborts.
    const ac = new AbortController();
    const backstop = setTimeout(() => ac.abort(), BUILD_TIMEOUT_MS);
    backstop.unref?.();
    try {
      await editApp(id, userId, parsed.data.instruction, (e: BuildEvent) => sse.send(e), ac.signal);
    } catch (err) {
      sse.send({ type: "error", message: (err as Error).message });
    } finally {
      clearTimeout(backstop);
    }
    sse.close();
  });

  // Download the project as a .zip (no external service needed).
  app.get("/api/fullstack/projects/:id/export", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getProject((request as AuthenticatedRequest).userId, id);
    if (!row) {
      return reply.status(404).send({ success: false, error: "Project not found", code: "not_found" });
    }
    const files = projectFiles(row.files);
    if (files.length === 0) {
      return reply.status(400).send({ success: false, error: "Nothing to export yet", code: "empty" });
    }
    const buf = await zipProject(files);
    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${zipName(row.name)}"`)
      .send(buf);
  });

  // Push the project to GitHub and return a one-click Render deploy link.
  app.post("/api/fullstack/projects/:id/deploy", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getProject((request as AuthenticatedRequest).userId, id);
    if (!row) {
      return reply.status(404).send({ success: false, error: "Project not found", code: "not_found" });
    }
    const files = projectFiles(row.files);
    if (files.length === 0) {
      return reply.status(400).send({ success: false, error: "Build the app before deploying", code: "empty" });
    }
    if (!githubConfigured()) {
      return reply.status(400).send({
        success: false,
        error:
          "Deploy needs a GitHub token. Add GITHUB_TOKEN (repo scope) to ~/omni/.env and restart the API, or use Export .zip.",
        code: "github_unconfigured",
      });
    }
    try {
      const result = await deployProject({ name: row.name, files, idSuffix: row.id });
      return { success: true, data: result };
    } catch (err) {
      return reply
        .status(502)
        .send({ success: false, error: (err as Error).message, code: "deploy_failed" });
    }
  });
}
