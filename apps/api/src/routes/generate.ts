// Generator SSE endpoints + artifacts CRUD.
//
// POST /api/generate/:name and /api/artifacts/:id/revise are ALWAYS SSE:
//   :pad -> {status}* -> {delta}* -> {artifact} | {error}
// Validation (unknown generator, bad body, ownership) happens BEFORE the
// reply is hijacked so plain JSON 400/404s still work — same pattern as
// chat.ts streamTurn.
import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import { copyFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR, all, fromJson, one, run, uuid } from "@omni/sdk";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { openSSE } from "../lib/sse.js";
import { getGenerator, getGeneratorForKind } from "../generators/registry.js";
import {
  toArtifactSummary,
  type ArtifactRow,
  type ArtifactSummary,
  type GenCtx,
} from "../generators/types.js";
import type { DocContent } from "../generators/doc.js";

const ARTIFACT_KINDS = new Set(["doc", "slides", "image", "sheet", "audio", "webpage"]);

const ReviseSchema = z.object({
  instruction: z.string().min(1).max(2000),
});

const ArtifactPatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  content: z.record(z.unknown()).optional(),
});

// Content types for artifact blobs (rel_path extension -> mime).
const BLOB_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
  md: "text/markdown",
  html: "text/html",
};

function blobExt(relPath: string): string {
  const dot = relPath.lastIndexOf(".");
  return dot > 0 ? relPath.slice(dot + 1).toLowerCase() : "";
}

// Only text-like exports are worth indexing for hub memory; images/audio
// have nothing extractable and would just churn the indexer.
function indexStatusForMime(mime: string): "pending" | "skipped" {
  return mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/pdf"
    ? "pending"
    : "skipped";
}

/** Detail/PATCH responses: the row flat, with content + meta JSON parsed. */
function serializeArtifact(row: ArtifactRow) {
  return {
    ...row,
    content: fromJson<Record<string, unknown>>(row.content),
    meta: fromJson<Record<string, unknown>>(row.meta),
  };
}

export async function generateRoutes(app: FastifyInstance) {
  function loadArtifact(id: string, userId: string): ArtifactRow | undefined {
    return one<ArtifactRow>(
      "SELECT * FROM artifacts WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
  }

  // Shared SSE runner for generate + revise. The generator emits its own
  // status/delta events; the terminal artifact/error frame is sent here.
  async function streamGeneration(
    request: AuthenticatedRequest,
    reply: FastifyReply,
    label: string,
    work: (ctx: GenCtx) => Promise<ArtifactSummary>,
  ) {
    const sse = openSSE(request, reply);
    const ac = new AbortController();
    sse.onClose(() => ac.abort());
    try {
      const artifact = await work({
        userId: request.userId,
        signal: ac.signal,
        emit: (e) => sse.send(e),
      });
      sse.sendTerminal({ type: "artifact", artifact });
    } catch (err) {
      request.log.error({ err, generator: label }, "[generate] run failed");
      sse.sendTerminal({
        type: "error",
        message: (err as Error).message?.slice(0, 300) ?? "Generation failed",
      });
    } finally {
      sse.close();
    }
  }

  // ── POST /api/generate/:name (SSE) ──
  app.post("/api/generate/:name", async (request, reply) => {
    const authed = request as AuthenticatedRequest;
    const { name } = request.params as { name: string };
    const generator = getGenerator(name);
    if (!generator) {
      return reply
        .status(404)
        .send({ success: false, error: "Unknown generator", code: "not_found" });
    }
    // Validate BEFORE hijacking so bad requests still get a JSON 400.
    const parsed = generator.inputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }

    await streamGeneration(authed, reply, name, (ctx) =>
      generator.run(parsed.data, ctx),
    );
    return reply;
  });

  // ── POST /api/artifacts/:id/revise (SSE) ──
  // Routes to the generator matching the artifact's kind; produces a NEW
  // artifact with parent_id = :id.
  app.post("/api/artifacts/:id/revise", async (request, reply) => {
    const authed = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const parsed = ReviseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const artifact = loadArtifact(id, authed.userId);
    if (!artifact) {
      return reply
        .status(404)
        .send({ success: false, error: "Artifact not found", code: "not_found" });
    }
    const generator = getGeneratorForKind(artifact.kind);
    if (artifact.kind === "audio" || !generator?.revise) {
      return reply.status(400).send({
        success: false,
        error: `${artifact.kind} artifacts are not revisable`,
        code: "not_revisable",
      });
    }
    const revise = generator.revise.bind(generator);

    await streamGeneration(authed, reply, `revise:${generator.name}`, (ctx) =>
      revise(id, parsed.data.instruction, ctx),
    );
    return reply;
  });

  // ── GET /api/artifacts ──
  app.get("/api/artifacts", async (request) => {
    const { userId } = request as AuthenticatedRequest;
    const query = request.query as { kind?: string; limit?: string };
    const limit = Math.min(Math.max(parseInt(query.limit ?? "50", 10) || 50, 1), 200);
    const params: unknown[] = [userId];
    let where = "user_id = ?";
    if (query.kind && ARTIFACT_KINDS.has(query.kind)) {
      where += " AND kind = ?";
      params.push(query.kind);
    }
    const rows = all<ArtifactRow>(
      `SELECT * FROM artifacts WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ...params,
      limit,
    );
    return { success: true, data: { artifacts: rows.map(toArtifactSummary) } };
  });

  // ── GET /api/artifacts/:id ──
  app.get("/api/artifacts/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const artifact = loadArtifact(id, userId);
    if (!artifact) {
      return reply
        .status(404)
        .send({ success: false, error: "Artifact not found", code: "not_found" });
    }
    return { success: true, data: serializeArtifact(artifact) };
  });

  // ── GET /api/artifacts/:id/blob ──
  app.get("/api/artifacts/:id/blob", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const artifact = loadArtifact(id, userId);
    if (!artifact) {
      return reply
        .status(404)
        .send({ success: false, error: "Artifact not found", code: "not_found" });
    }
    if (!artifact.rel_path) {
      return reply
        .status(404)
        .send({ success: false, error: "Artifact has no blob", code: "no_blob" });
    }
    const absPath = join(DATA_DIR, artifact.rel_path);
    let size: number;
    try {
      size = (await stat(absPath)).size;
    } catch {
      return reply.status(404).send({
        success: false,
        error: "Artifact blob missing on disk",
        code: "blob_missing",
      });
    }
    reply
      .header(
        "Content-Type",
        BLOB_MIME[blobExt(artifact.rel_path)] ?? "application/octet-stream",
      )
      .header("Content-Length", String(size))
      .header("Cache-Control", "private, max-age=3600");
    return reply.send(createReadStream(absPath));
  });

  // ── PATCH /api/artifacts/:id ──
  // The doc editor saves {markdown, blocks, sources} through content here.
  app.patch("/api/artifacts/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const parsed = ArtifactPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const artifact = loadArtifact(id, userId);
    if (!artifact) {
      return reply
        .status(404)
        .send({ success: false, error: "Artifact not found", code: "not_found" });
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (parsed.data.title !== undefined) {
      sets.push("title = ?");
      params.push(parsed.data.title);
    }
    if (parsed.data.content !== undefined) {
      sets.push("content = ?");
      params.push(JSON.stringify(parsed.data.content));
    }
    if (sets.length > 0) {
      run(`UPDATE artifacts SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    }
    const updated = one<ArtifactRow>("SELECT * FROM artifacts WHERE id = ?", id);
    return { success: true, data: serializeArtifact(updated as ArtifactRow) };
  });

  // ── DELETE /api/artifacts/:id ──
  // Row delete first (children keep living — parent_id is ON DELETE SET
  // NULL), then unlink the blob ignoring ENOENT.
  app.delete("/api/artifacts/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const artifact = loadArtifact(id, userId);
    if (!artifact) {
      return reply
        .status(404)
        .send({ success: false, error: "Artifact not found", code: "not_found" });
    }
    run("DELETE FROM artifacts WHERE id = ?", id);
    if (artifact.rel_path) {
      try {
        await unlink(join(DATA_DIR, artifact.rel_path));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          request.log.warn({ err, artifactId: id }, "[artifacts] blob unlink failed");
        }
      }
    }
    return { success: true, data: { deleted: true } };
  });

  // ── POST /api/artifacts/:id/export-to-drive ──
  // Copies the blob (or writes a doc's markdown as .md) into the Drive,
  // inserts a drive_files row (origin 'generated'), and links it back on
  // the artifact. Text-like exports enter the indexing queue so a hub
  // attach can embed them; images/audio are skipped.
  app.post("/api/artifacts/:id/export-to-drive", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const artifact = loadArtifact(id, userId);
    if (!artifact) {
      return reply
        .status(404)
        .send({ success: false, error: "Artifact not found", code: "not_found" });
    }

    const fileId = uuid();
    let relPath: string;
    let mime: string;
    let name: string;
    let sizeBytes: number;

    if (artifact.kind === "doc") {
      const markdown = fromJson<DocContent>(artifact.content)?.markdown;
      if (!markdown?.trim()) {
        return reply.status(400).send({
          success: false,
          error: "Document has no markdown to export",
          code: "no_content",
        });
      }
      relPath = `drive/${fileId}.md`;
      mime = "text/markdown";
      name = `${artifact.title}.md`;
      const bytes = Buffer.from(markdown, "utf8");
      sizeBytes = bytes.length;
      const absPath = join(DATA_DIR, relPath);
      await writeFile(`${absPath}.part`, bytes);
      await rename(`${absPath}.part`, absPath);
    } else {
      if (!artifact.rel_path) {
        return reply.status(400).send({
          success: false,
          error: "Artifact has no blob to export",
          code: "no_blob",
        });
      }
      const srcPath = join(DATA_DIR, artifact.rel_path);
      try {
        sizeBytes = (await stat(srcPath)).size;
      } catch {
        return reply.status(404).send({
          success: false,
          error: "Artifact blob missing on disk",
          code: "blob_missing",
        });
      }
      const ext = blobExt(artifact.rel_path);
      relPath = ext ? `drive/${fileId}.${ext}` : `drive/${fileId}`;
      mime = BLOB_MIME[ext] ?? "application/octet-stream";
      name = ext ? `${artifact.title}.${ext}` : artifact.title;
      const absPath = join(DATA_DIR, relPath);
      await copyFile(srcPath, `${absPath}.part`);
      await rename(`${absPath}.part`, absPath);
    }

    run(
      `INSERT INTO drive_files (id, user_id, name, mime, size_bytes, rel_path, origin, index_status)
       VALUES (?, ?, ?, ?, ?, ?, 'generated', ?)`,
      fileId,
      userId,
      name.slice(0, 300),
      mime,
      sizeBytes,
      relPath,
      indexStatusForMime(mime),
    );
    run("UPDATE artifacts SET drive_file_id = ? WHERE id = ?", fileId, id);

    return {
      success: true,
      data: one<Record<string, unknown>>("SELECT * FROM drive_files WHERE id = ?", fileId),
    };
  });
}
