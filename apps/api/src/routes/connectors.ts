// Connectors REST — the app-connector store over Composio managed OAuth. This
// GENERALIZES routes/secretary.ts (Gmail/Calendar only) to the full connector
// catalog: every entry is connectable through the same composio.ts primitives.
//
//   GET    /api/connectors                  — catalog annotated with per-app status
//   POST   /api/connectors/:toolkit/connect — hosted-OAuth redirect URL
//   POST   /api/connectors/:toolkit/refresh — re-check one toolkit's status
//   DELETE /api/connectors/:toolkit         — disconnect a toolkit
//
// Fails soft without COMPOSIO_API_KEY: GET reports configured:false with every
// connector "none"; connect/refresh 400 with code "connectors_unconfigured".
// Unknown toolkits (not in the catalog) 404. GET reads connection state from the
// DB (listConnections) rather than hitting Composio per-app — /refresh is the
// live re-check used while polling after a connect.

import type { FastifyInstance } from "fastify";
import {
  composioEnabled,
  connectToolkit,
  connectionStatus,
  disconnectToolkit,
  listConnections,
} from "../lib/composio.js";
import { CONNECTOR_CATALOG, getConnector } from "../lib/connectors.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

// The four states the connector UI renders. "error" (from the connections table)
// is passed through too so a failed/expired connection is visible.
type ConnectorStatus = "active" | "pending" | "disconnected" | "error" | "none";

// Return the user to the Connectors page after the hosted OAuth flow. Best-effort
// from the request origin; Composio falls back to its hosted page when absent.
function callbackFromRequest(request: { headers: Record<string, unknown> }): string | undefined {
  const origin = request.headers["origin"];
  const o = Array.isArray(origin) ? origin[0] : origin;
  return typeof o === "string" && /^https?:\/\//.test(o) ? `${o}/connectors` : undefined;
}

export async function connectorRoutes(app: FastifyInstance) {
  // ── GET /api/connectors ── catalog + per-app connection status (DB read)
  app.get("/api/connectors", async (request) => {
    const { userId } = request as AuthenticatedRequest;
    const configured = composioEnabled();

    // One DB read; map toolkit -> stored status. Absent = "none".
    const byToolkit = new Map<string, ConnectorStatus>();
    if (configured) {
      for (const row of listConnections(userId)) {
        byToolkit.set(row.toolkit, row.status as ConnectorStatus);
      }
    }

    const connectors = CONNECTOR_CATALOG.map((c) => ({
      ...c,
      status: (configured ? (byToolkit.get(c.toolkit) ?? "none") : "none") as ConnectorStatus,
    }));

    return { success: true, data: { configured, connectors } };
  });

  // ── POST /api/connectors/:toolkit/connect ── → hosted OAuth redirect URL
  app.post("/api/connectors/:toolkit/connect", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { toolkit } = request.params as { toolkit: string };
    const meta = getConnector(toolkit);
    if (!meta) {
      return reply.status(404).send({ success: false, error: "Unknown connector", code: "not_found" });
    }
    if (!composioEnabled()) {
      return reply.status(400).send({
        success: false,
        error: "Connectors are not configured. Add COMPOSIO_API_KEY to connect apps.",
        code: "connectors_unconfigured",
      });
    }
    const result = await connectToolkit(userId, meta.toolkit, callbackFromRequest(request));
    if (result.status !== "ok" || !result.redirectUrl) {
      return reply.status(502).send({
        success: false,
        error: "Could not start the connection. Please try again.",
        code: "connect_failed",
      });
    }
    return { success: true, data: { redirectUrl: result.redirectUrl } };
  });

  // ── POST /api/connectors/:toolkit/refresh ── live re-check of one toolkit
  app.post("/api/connectors/:toolkit/refresh", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { toolkit } = request.params as { toolkit: string };
    const meta = getConnector(toolkit);
    if (!meta) {
      return reply.status(404).send({ success: false, error: "Unknown connector", code: "not_found" });
    }
    if (!composioEnabled()) {
      return reply.status(400).send({
        success: false,
        error: "Connectors are not configured.",
        code: "connectors_unconfigured",
      });
    }
    const row = await connectionStatus(userId, meta.toolkit);
    return { success: true, data: { toolkit: row.toolkit, status: row.status } };
  });

  // ── DELETE /api/connectors/:toolkit ── disconnect a toolkit
  app.delete("/api/connectors/:toolkit", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { toolkit } = request.params as { toolkit: string };
    const meta = getConnector(toolkit);
    if (!meta) {
      return reply.status(404).send({ success: false, error: "Unknown connector", code: "not_found" });
    }
    await disconnectToolkit(userId, meta.toolkit);
    return { success: true, data: { ok: true } };
  });
}
