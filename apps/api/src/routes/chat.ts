// Chat threads + streaming messages.
//
// POST /api/chat/threads/:id/messages and .../regenerate are ALWAYS SSE:
//   :pad -> {start} -> {sources}? -> {delta}* -> {usage} -> {done}|{error}
// Validation and the thread-ownership check happen BEFORE the reply is
// hijacked so plain JSON 400/404s still work.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { MODELS, all, fromJson, nowISO, one, run, uuid } from "@omni/sdk";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { openSSE } from "../lib/sse.js";
import { runChatTurn, type ChatTurnResult } from "../lib/chat-turn.js";

interface ThreadRow {
  id: string;
  user_id: string;
  hub_id: string | null;
  title: string;
  model: string;
  usage_totals: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  user_id: string;
  role: string;
  content: string;
  model: string | null;
  usage: string | null;
  tool_calls: string | null;
  attachments: string | null;
  citations: string | null;
  error: string | null;
  created_at: string;
}

function serializeThread(row: ThreadRow) {
  return { ...row, usage_totals: fromJson<Record<string, number>>(row.usage_totals) };
}

function serializeMessage(row: MessageRow) {
  return {
    ...row,
    usage: fromJson<Record<string, unknown>>(row.usage),
    tool_calls: fromJson<unknown[]>(row.tool_calls),
    attachments: fromJson<unknown[]>(row.attachments),
    citations: fromJson<unknown[]>(row.citations),
  };
}

const ThreadCreateSchema = z.object({
  hub_id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  title: z.string().min(1).max(200).optional(),
});

const ThreadPatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  model: z.string().min(1).optional(),
  hub_id: z.string().min(1).nullable().optional(),
});

const MessageSchema = z.object({
  content: z.string().min(1),
  attachments: z.array(z.string().min(1)).max(20).optional(),
  model: z.string().min(1).optional(),
});

const RegenerateSchema = z.object({
  model: z.string().min(1).optional(),
});

export async function chatRoutes(app: FastifyInstance) {
  // ── GET /api/chat/threads ──
  app.get("/api/chat/threads", async (request) => {
    const { userId } = request as AuthenticatedRequest;
    const query = request.query as { hub_id?: string; limit?: string };
    const limit = Math.min(Math.max(parseInt(query.limit ?? "100", 10) || 100, 1), 200);
    const params: unknown[] = [userId];
    let where = "user_id = ?";
    if (query.hub_id) {
      where += " AND hub_id = ?";
      params.push(query.hub_id);
    }
    const threads = all<ThreadRow>(
      `SELECT * FROM chat_threads WHERE ${where} ORDER BY updated_at DESC LIMIT ?`,
      ...params,
      limit,
    );
    return { success: true, data: { threads: threads.map(serializeThread) } };
  });

  // ── POST /api/chat/threads ──
  app.post("/api/chat/threads", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const parsed = ThreadCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const body = parsed.data;

    let hub: { id: string; default_model: string | null } | undefined;
    if (body.hub_id) {
      hub = one<{ id: string; default_model: string | null }>(
        "SELECT id, default_model FROM hubs WHERE id = ? AND user_id = ?",
        body.hub_id,
        userId,
      );
      if (!hub) {
        return reply
          .status(404)
          .send({ success: false, error: "Hub not found", code: "not_found" });
      }
    }

    // Model resolution: explicit -> hub default -> user default -> registry default.
    const settings = one<{ default_model: string }>(
      "SELECT default_model FROM user_settings WHERE user_id = ?",
      userId,
    );
    const model =
      body.model ?? hub?.default_model ?? settings?.default_model ?? MODELS.default;

    const id = uuid();
    run(
      `INSERT INTO chat_threads (id, user_id, hub_id, title, model)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      userId,
      body.hub_id ?? null,
      body.title ?? "New chat",
      model,
    );
    const thread = one<ThreadRow>("SELECT * FROM chat_threads WHERE id = ?", id);
    return { success: true, data: serializeThread(thread as ThreadRow) };
  });

  // ── GET /api/chat/threads/:id ──
  app.get("/api/chat/threads/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const thread = one<ThreadRow>(
      "SELECT * FROM chat_threads WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    if (!thread) {
      return reply
        .status(404)
        .send({ success: false, error: "Thread not found", code: "not_found" });
    }
    const messages = all<MessageRow>(
      "SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC",
      id,
    );
    return {
      success: true,
      data: { ...serializeThread(thread), messages: messages.map(serializeMessage) },
    };
  });

  // ── PATCH /api/chat/threads/:id ──
  app.patch("/api/chat/threads/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const parsed = ThreadPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const body = parsed.data;
    const thread = one<ThreadRow>(
      "SELECT * FROM chat_threads WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    if (!thread) {
      return reply
        .status(404)
        .send({ success: false, error: "Thread not found", code: "not_found" });
    }
    if (body.hub_id) {
      const hub = one<{ id: string }>(
        "SELECT id FROM hubs WHERE id = ? AND user_id = ?",
        body.hub_id,
        userId,
      );
      if (!hub) {
        return reply
          .status(404)
          .send({ success: false, error: "Hub not found", code: "not_found" });
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.title !== undefined) {
      sets.push("title = ?");
      params.push(body.title);
    }
    if (body.model !== undefined) {
      sets.push("model = ?");
      params.push(body.model);
    }
    if (body.hub_id !== undefined) {
      sets.push("hub_id = ?");
      params.push(body.hub_id); // null clears the hub link
    }
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      params.push(nowISO());
      run(`UPDATE chat_threads SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    }
    const updated = one<ThreadRow>("SELECT * FROM chat_threads WHERE id = ?", id);
    return { success: true, data: serializeThread(updated as ThreadRow) };
  });

  // ── DELETE /api/chat/threads/:id ──
  app.delete("/api/chat/threads/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const res = run(
      "DELETE FROM chat_threads WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    if (res.changes === 0) {
      return reply
        .status(404)
        .send({ success: false, error: "Thread not found", code: "not_found" });
    }
    return { success: true, data: { deleted: true } };
  });

  // Shared SSE runner for messages + regenerate.
  async function streamTurn(
    request: AuthenticatedRequest,
    reply: FastifyReply,
    turn: {
      threadId: string;
      content: string;
      attachments?: string[];
      model?: string;
      persistUserMessage: boolean;
    },
  ) {
    const sse = openSSE(request, reply);
    const ac = new AbortController();
    sse.onClose(() => ac.abort());
    try {
      const result: ChatTurnResult = await runChatTurn({
        threadId: turn.threadId,
        userId: request.userId,
        content: turn.content,
        attachments: turn.attachments,
        model: turn.model,
        emit: (event) => sse.send(event),
        signal: ac.signal,
        persistUserMessage: turn.persistUserMessage,
      });
      sse.sendTerminal({
        type: "done",
        threadId: turn.threadId,
        messageId: result.messageId,
        text: result.text,
        ...(result.title ? { title: result.title } : {}),
      });
    } catch (err) {
      request.log.error(
        { err, threadId: turn.threadId },
        "[chat] streaming turn failed",
      );
      sse.sendTerminal({
        type: "error",
        message: (err as Error).message?.slice(0, 300) ?? "Chat turn failed",
      });
    } finally {
      sse.close();
    }
  }

  // ── POST /api/chat/threads/:id/messages (SSE) ──
  app.post("/api/chat/threads/:id/messages", async (request, reply) => {
    const authed = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    // Validate BEFORE hijacking so bad requests still get a JSON 400/404.
    const parsed = MessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const thread = one<{ id: string }>(
      "SELECT id FROM chat_threads WHERE id = ? AND user_id = ?",
      id,
      authed.userId,
    );
    if (!thread) {
      return reply
        .status(404)
        .send({ success: false, error: "Thread not found", code: "not_found" });
    }

    await streamTurn(authed, reply, {
      threadId: id,
      content: parsed.data.content,
      attachments: parsed.data.attachments,
      model: parsed.data.model,
      persistUserMessage: true,
    });
    return reply;
  });

  // ── POST /api/chat/threads/:id/regenerate (SSE) ──
  // Deletes the trailing assistant message(s) and re-runs the last user turn.
  app.post("/api/chat/threads/:id/regenerate", async (request, reply) => {
    const authed = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const parsed = RegenerateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const thread = one<{ id: string }>(
      "SELECT id FROM chat_threads WHERE id = ? AND user_id = ?",
      id,
      authed.userId,
    );
    if (!thread) {
      return reply
        .status(404)
        .send({ success: false, error: "Thread not found", code: "not_found" });
    }

    const messages = all<{ id: string; role: string; content: string }>(
      "SELECT id, role, content FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC",
      id,
    );
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) {
      return reply.status(400).send({
        success: false,
        error: "No user message to regenerate from",
        code: "nothing_to_regenerate",
      });
    }
    // Drop everything after the last user message (assistant/tool turns).
    for (const m of messages.slice(lastUserIdx + 1)) {
      run("DELETE FROM chat_messages WHERE id = ?", m.id);
    }

    await streamTurn(authed, reply, {
      threadId: id,
      content: messages[lastUserIdx].content,
      model: parsed.data.model,
      persistUserMessage: false,
    });
    return reply;
  });
}
