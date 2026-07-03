// AI Drive: file metadata in SQLite, blobs on the filesystem under
// ${DATA_DIR}/drive/<id>.<ext>. Uploads are magic-byte sniffed (PDF/PNG/JPEG)
// and written .part-then-rename atomically; ingestion is handled by the
// background loop in lib/drive-index.ts (rows start at index_status=pending).
import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DATA_DIR, all, nowISO, one, run, uuid } from "@omni/sdk";
import type { AuthenticatedRequest } from "../middleware/auth.js";

interface DriveFileRow {
  id: string;
  user_id: string;
  name: string;
  mime: string;
  size_bytes: number;
  rel_path: string;
  origin: string;
  index_status: string;
  index_error: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const RenameSchema = z.object({
  name: z.string().min(1).max(300),
});

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "application/json": "json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

function safeExt(filename: string, mime: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot > 0) {
    const ext = filename.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,10}$/.test(ext)) return ext;
  }
  return EXT_BY_MIME[mime.toLowerCase().split(";")[0].trim()] ?? "";
}

/**
 * Trust the bytes, not the declared name/mime (Flo101 files.ts posture).
 * Only formats with well-known signatures are checked; everything else
 * passes through (the extractor decides what it can do with it).
 */
function magicBytesOk(buffer: Buffer, ext: string, mime: string): boolean {
  const b = buffer;
  const claims = (want: string) =>
    ext === want || mime.includes(want === "jpg" ? "jpeg" : want);
  if (claims("pdf")) {
    // "%PDF-"
    return (
      b.length >= 5 &&
      b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d
    );
  }
  if (claims("png")) {
    return b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  }
  if (ext === "jpg" || ext === "jpeg" || mime.includes("jpeg")) {
    return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  }
  return true;
}

export async function driveRoutes(app: FastifyInstance) {
  // ── GET /api/drive/files ──
  app.get("/api/drive/files", async (request) => {
    const { userId } = request as AuthenticatedRequest;
    const query = request.query as { q?: string; hub_id?: string };
    const params: unknown[] = [];
    let sql = "SELECT f.* FROM drive_files f";
    if (query.hub_id) {
      sql += " JOIN hub_files hf ON hf.file_id = f.id AND hf.hub_id = ?";
      params.push(query.hub_id);
    }
    sql += " WHERE f.user_id = ?";
    params.push(userId);
    if (query.q) {
      sql += " AND f.name LIKE ?";
      params.push(`%${query.q.replace(/[%_]/g, (c) => `\\${c}`)}%`);
      sql += " ESCAPE '\\'";
    }
    sql += " ORDER BY f.created_at DESC LIMIT 200";
    return { success: true, data: { files: all<DriveFileRow>(sql, ...params) } };
  });

  // ── POST /api/drive/files (multipart) ──
  app.post("/api/drive/files", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;

    let buffer: Buffer;
    let filename: string;
    let mime: string;
    try {
      const part = await request.file();
      if (!part) {
        return reply
          .status(400)
          .send({ success: false, error: "No file uploaded", code: "no_file" });
      }
      buffer = await part.toBuffer();
      filename = (part.filename || "untitled").slice(0, 300);
      mime = (part.mimetype || "application/octet-stream").toLowerCase();
    } catch (err) {
      request.log.warn({ err }, "[drive] multipart read failed");
      return reply
        .status(400)
        .send({ success: false, error: "Malformed upload", code: "bad_upload" });
    }
    if (buffer.length === 0) {
      return reply
        .status(400)
        .send({ success: false, error: "Empty file", code: "empty_file" });
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return reply
        .status(413)
        .send({ success: false, error: "File must be under 20MB", code: "too_large" });
    }

    const ext = safeExt(filename, mime);
    if (!magicBytesOk(buffer, ext, mime)) {
      return reply.status(400).send({
        success: false,
        error: "File contents don't match its declared type (bad header)",
        code: "bad_magic_bytes",
      });
    }

    const id = uuid();
    const relPath = ext ? `drive/${id}.${ext}` : `drive/${id}`;
    const absPath = join(DATA_DIR, relPath);

    // Atomic blob write: .part then rename, so a crash never leaves a
    // half-written file behind a committed DB row.
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(`${absPath}.part`, buffer);
    await rename(`${absPath}.part`, absPath);

    run(
      `INSERT INTO drive_files (id, user_id, name, mime, size_bytes, rel_path, origin, index_status)
       VALUES (?, ?, ?, ?, ?, ?, 'upload', 'pending')`,
      id,
      userId,
      filename,
      mime,
      buffer.length,
      relPath,
    );
    return {
      success: true,
      data: one<DriveFileRow>("SELECT * FROM drive_files WHERE id = ?", id),
    };
  });

  // ── GET /api/drive/files/:id ──
  app.get("/api/drive/files/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const file = one<DriveFileRow>(
      "SELECT * FROM drive_files WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    if (!file) {
      return reply
        .status(404)
        .send({ success: false, error: "File not found", code: "not_found" });
    }
    return { success: true, data: file };
  });

  // ── GET /api/drive/files/:id/download ──
  app.get("/api/drive/files/:id/download", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const query = request.query as { inline?: string };
    const file = one<DriveFileRow>(
      "SELECT * FROM drive_files WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    if (!file) {
      return reply
        .status(404)
        .send({ success: false, error: "File not found", code: "not_found" });
    }
    const absPath = join(DATA_DIR, file.rel_path);
    let size: number;
    try {
      size = (await stat(absPath)).size;
    } catch {
      return reply.status(404).send({
        success: false,
        error: "File blob missing on disk",
        code: "blob_missing",
      });
    }

    const disposition = query.inline === "1" ? "inline" : "attachment";
    // ASCII fallback + RFC 5987 encoded full name.
    const asciiName = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    reply
      .header("Content-Type", file.mime || "application/octet-stream")
      .header("Content-Length", String(size))
      .header(
        "Content-Disposition",
        `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      );
    return reply.send(createReadStream(absPath));
  });

  // ── PATCH /api/drive/files/:id (rename) ──
  app.patch("/api/drive/files/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const parsed = RenameSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const res = run(
      "UPDATE drive_files SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?",
      parsed.data.name,
      nowISO(),
      id,
      userId,
    );
    if (res.changes === 0) {
      return reply
        .status(404)
        .send({ success: false, error: "File not found", code: "not_found" });
    }
    return {
      success: true,
      data: one<DriveFileRow>("SELECT * FROM drive_files WHERE id = ?", id),
    };
  });

  // ── DELETE /api/drive/files/:id ──
  // Row delete first (FK cascades hub_files + chunks; the chunk delete
  // trigger cleans vec rows), then unlink the blob ignoring ENOENT.
  app.delete("/api/drive/files/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const file = one<DriveFileRow>(
      "SELECT * FROM drive_files WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    if (!file) {
      return reply
        .status(404)
        .send({ success: false, error: "File not found", code: "not_found" });
    }
    run("DELETE FROM drive_files WHERE id = ?", id);
    try {
      await unlink(join(DATA_DIR, file.rel_path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        request.log.warn({ err, fileId: id }, "[drive] blob unlink failed");
      }
    }
    return { success: true, data: { deleted: true } };
  });
}
