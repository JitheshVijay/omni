// Hubs: project spaces with instructions, attached Drive files, and
// persistent vector memory.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, embedText, nowISO, one, run, uuid } from "@omni/sdk";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { deleteChunksForHubFile, searchHubMemory } from "../lib/hub-memory.js";
import { indexFileForHub } from "../lib/drive-index.js";

interface HubRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  default_model: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
}

const HubCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(20_000).optional(),
  default_model: z.string().min(1).optional(),
});

const HubPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  instructions: z.string().max(20_000).nullable().optional(),
  default_model: z.string().min(1).nullable().optional(),
  archived: z.boolean().optional(),
});

const AttachFileSchema = z.object({
  file_id: z.string().min(1),
});

const MemorySearchSchema = z.object({
  query: z.string().min(1),
  k: z.number().int().min(1).max(50).optional(),
});

function loadHub(hubId: string, userId: string): HubRow | undefined {
  return one<HubRow>(
    "SELECT * FROM hubs WHERE id = ? AND user_id = ?",
    hubId,
    userId,
  );
}

export async function hubsRoutes(app: FastifyInstance) {
  // ── GET /api/hubs ──
  app.get("/api/hubs", async (request) => {
    const { userId } = request as AuthenticatedRequest;
    const hubs = all<HubRow & { thread_count: number; file_count: number }>(
      `SELECT h.*,
              (SELECT COUNT(*) FROM chat_threads t WHERE t.hub_id = h.id) AS thread_count,
              (SELECT COUNT(*) FROM hub_files hf WHERE hf.hub_id = h.id) AS file_count
         FROM hubs h
        WHERE h.user_id = ?
        ORDER BY h.updated_at DESC`,
      userId,
    );
    return { success: true, data: { hubs } };
  });

  // ── POST /api/hubs ──
  app.post("/api/hubs", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const parsed = HubCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const body = parsed.data;
    const id = uuid();
    run(
      `INSERT INTO hubs (id, user_id, name, description, instructions, default_model)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      body.name,
      body.description ?? null,
      body.instructions ?? null,
      body.default_model ?? null,
    );
    return { success: true, data: one<HubRow>("SELECT * FROM hubs WHERE id = ?", id) };
  });

  // ── GET /api/hubs/:id ──
  app.get("/api/hubs/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const hub = loadHub(id, userId);
    if (!hub) {
      return reply
        .status(404)
        .send({ success: false, error: "Hub not found", code: "not_found" });
    }
    const files = all(
      `SELECT f.id, f.name, f.mime, f.size_bytes, f.origin, f.index_status,
              f.index_error, f.created_at, hf.created_at AS attached_at
         FROM hub_files hf
         JOIN drive_files f ON f.id = hf.file_id
        WHERE hf.hub_id = ?
        ORDER BY hf.created_at DESC`,
      id,
    );
    const threads = all(
      `SELECT id, title, model, created_at, updated_at
         FROM chat_threads
        WHERE hub_id = ? AND user_id = ?
        ORDER BY updated_at DESC
        LIMIT 10`,
      id,
      userId,
    );
    return { success: true, data: { ...hub, files, threads } };
  });

  // ── PATCH /api/hubs/:id ──
  app.patch("/api/hubs/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const parsed = HubPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const hub = loadHub(id, userId);
    if (!hub) {
      return reply
        .status(404)
        .send({ success: false, error: "Hub not found", code: "not_found" });
    }
    const body = parsed.data;
    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.name !== undefined) {
      sets.push("name = ?");
      params.push(body.name);
    }
    if (body.description !== undefined) {
      sets.push("description = ?");
      params.push(body.description);
    }
    if (body.instructions !== undefined) {
      sets.push("instructions = ?");
      params.push(body.instructions);
    }
    if (body.default_model !== undefined) {
      sets.push("default_model = ?");
      params.push(body.default_model);
    }
    if (body.archived !== undefined) {
      sets.push("archived = ?");
      params.push(body.archived ? 1 : 0);
    }
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      params.push(nowISO());
      run(`UPDATE hubs SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    }
    return { success: true, data: one<HubRow>("SELECT * FROM hubs WHERE id = ?", id) };
  });

  // ── DELETE /api/hubs/:id ──
  // FK cascades take hub_files + hub_memory_chunks (whose delete trigger
  // cleans the vec index); threads get hub_id = NULL.
  app.delete("/api/hubs/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const res = run("DELETE FROM hubs WHERE id = ? AND user_id = ?", id, userId);
    if (res.changes === 0) {
      return reply
        .status(404)
        .send({ success: false, error: "Hub not found", code: "not_found" });
    }
    return { success: true, data: { deleted: true } };
  });

  // ── POST /api/hubs/:id/files ── attach a Drive file
  app.post("/api/hubs/:id/files", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const parsed = AttachFileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const hub = loadHub(id, userId);
    if (!hub) {
      return reply
        .status(404)
        .send({ success: false, error: "Hub not found", code: "not_found" });
    }
    const file = one<{ id: string; index_status: string }>(
      "SELECT id, index_status FROM drive_files WHERE id = ? AND user_id = ?",
      parsed.data.file_id,
      userId,
    );
    if (!file) {
      return reply
        .status(404)
        .send({ success: false, error: "File not found", code: "not_found" });
    }

    run(
      "INSERT OR IGNORE INTO hub_files (hub_id, file_id, user_id) VALUES (?, ?, ?)",
      id,
      file.id,
      userId,
    );

    // Already-indexed files won't pass through the background loop again —
    // chunk them into this hub now, fire-and-forget. Pending/in-flight files
    // get their chunks written by the loop when it reaches them.
    if (file.index_status === "ready") {
      void indexFileForHub(file.id, id).catch((err) => {
        request.log.warn(
          { err: (err as Error).message, fileId: file.id, hubId: id },
          "[hubs] attach indexing failed",
        );
      });
    }
    return { success: true, data: { attached: true, file_id: file.id, hub_id: id } };
  });

  // ── DELETE /api/hubs/:id/files/:fileId ── detach + drop this hub's chunks
  app.delete("/api/hubs/:id/files/:fileId", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id, fileId } = request.params as { id: string; fileId: string };
    const hub = loadHub(id, userId);
    if (!hub) {
      return reply
        .status(404)
        .send({ success: false, error: "Hub not found", code: "not_found" });
    }
    deleteChunksForHubFile(id, fileId);
    const res = run(
      "DELETE FROM hub_files WHERE hub_id = ? AND file_id = ?",
      id,
      fileId,
    );
    if (res.changes === 0) {
      return reply
        .status(404)
        .send({ success: false, error: "File not attached to hub", code: "not_found" });
    }
    return { success: true, data: { detached: true } };
  });

  // ── POST /api/hubs/:id/memory/search ──
  app.post("/api/hubs/:id/memory/search", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const parsed = MemorySearchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const hub = loadHub(id, userId);
    if (!hub) {
      return reply
        .status(404)
        .send({ success: false, error: "Hub not found", code: "not_found" });
    }
    const embedding = await embedText(parsed.data.query);
    if (!embedding) {
      return reply.status(502).send({
        success: false,
        error: "Embedding service unavailable",
        code: "embedding_unavailable",
      });
    }
    const results = searchHubMemory(id, embedding, parsed.data.k ?? 8);
    return { success: true, data: { results } };
  });
}
