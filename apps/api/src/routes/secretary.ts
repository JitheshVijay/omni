// AI Secretary REST — Composio connection management for Gmail + Google
// Calendar plus the "Today" briefing. Everything fails soft without
// COMPOSIO_API_KEY: /status reports configured:false and /connect 400s with
// code "secretary_unconfigured". The briefing reuses the Super Agent: /brief
// creates a normal agent run and returns its id so the UI opens /agent/:id.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nowISO, run as dbRun, uuid } from "@omni/sdk";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  composioEnabled,
  connectToolkit,
  connectionStatus,
  disconnectToolkit,
  isSecretaryToolkit,
  SECRETARY_TOOLKITS,
} from "../lib/composio.js";
import { startRun } from "../agent/orchestrator.js";

const ToolkitSchema = z.object({
  toolkit: z.enum(SECRETARY_TOOLKITS),
});

const BRIEF_GOAL =
  "Give me my Today briefing. Summarize my unread emails since yesterday and " +
  "today's Google Calendar. List anything that needs a reply or my attention, " +
  "grouped by priority. Be concise. Do not send anything or create any events — " +
  "read only.";

// Derive a callback URL to return the user to the Secretary page after the
// hosted OAuth flow. Best-effort from the request origin; Composio falls back to
// its own hosted success page when absent.
function callbackFromRequest(request: { headers: Record<string, unknown> }): string | undefined {
  const origin = request.headers["origin"];
  const o = Array.isArray(origin) ? origin[0] : origin;
  return typeof o === "string" && /^https?:\/\//.test(o) ? `${o}/secretary` : undefined;
}

export async function secretaryRoutes(app: FastifyInstance) {
  // ── GET /api/secretary/status ──
  app.get("/api/secretary/status", async (request) => {
    const { userId } = request as AuthenticatedRequest;
    const configured = composioEnabled();
    if (!configured) {
      return { success: true, data: { configured: false, connections: [] } };
    }
    // Refresh each toolkit against Composio (fail-soft) so the UI is current.
    const connections = [];
    for (const tk of SECRETARY_TOOLKITS) {
      try {
        const row = await connectionStatus(userId, tk);
        connections.push({ toolkit: row.toolkit, status: row.status });
      } catch {
        connections.push({ toolkit: tk, status: "pending" as const });
      }
    }
    return { success: true, data: { configured: true, connections } };
  });

  // ── POST /api/secretary/connect ── → hosted OAuth redirect URL
  app.post("/api/secretary/connect", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const parsed = ToolkitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    if (!composioEnabled()) {
      return reply.status(400).send({
        success: false,
        error: "The Secretary is not configured. Add COMPOSIO_API_KEY to enable Gmail and Calendar.",
        code: "secretary_unconfigured",
      });
    }
    const result = await connectToolkit(userId, parsed.data.toolkit, callbackFromRequest(request));
    if (result.status !== "ok" || !result.redirectUrl) {
      return reply.status(502).send({
        success: false,
        error: "Could not start the connection. Please try again.",
        code: "connect_failed",
      });
    }
    return { success: true, data: { redirectUrl: result.redirectUrl } };
  });

  // ── POST /api/secretary/refresh ── re-check one toolkit's status
  app.post("/api/secretary/refresh", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const parsed = ToolkitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    if (!composioEnabled()) {
      return reply.status(400).send({
        success: false,
        error: "The Secretary is not configured.",
        code: "secretary_unconfigured",
      });
    }
    const row = await connectionStatus(userId, parsed.data.toolkit);
    return { success: true, data: { toolkit: row.toolkit, status: row.status } };
  });

  // ── DELETE /api/secretary/connections/:toolkit ──
  app.delete("/api/secretary/connections/:toolkit", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { toolkit } = request.params as { toolkit: string };
    if (!isSecretaryToolkit(toolkit)) {
      return reply.status(400).send({ success: false, error: "Unknown toolkit", code: "bad_toolkit" });
    }
    await disconnectToolkit(userId, toolkit);
    return { success: true, data: { ok: true } };
  });

  // ── POST /api/secretary/brief ── create a bounded agent run for the briefing
  app.post("/api/secretary/brief", async (request) => {
    const { userId } = request as AuthenticatedRequest;
    const id = uuid();
    dbRun(
      `INSERT INTO agent_runs (id, user_id, hub_id, thread_id, title, goal, status, model, budget_usd, created_at)
       VALUES (?, ?, NULL, NULL, ?, ?, 'queued', NULL, ?, ?)`,
      id,
      userId,
      "Today briefing",
      BRIEF_GOAL,
      0.5,
      nowISO(),
    );
    void startRun(id).catch((err) => {
      request.log.error({ err, runId: id }, "[secretary] brief startRun crashed");
    });
    return { success: true, data: { run_id: id } };
  });
}
