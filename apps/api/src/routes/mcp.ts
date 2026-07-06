// MCP host REST. Read + refresh the Model Context Protocol servers Omni is
// connected to (Omni is the *host*; the configured servers provide the tools).
//   GET  /api/mcp/servers  — per-server status + total tool count
//   POST /api/mcp/reload   — re-read mcp.json + reconnect, return fresh status
//
// Envelope {success,data} and auth are automatic: the app's onRequest hook
// covers every /api/* route.

import type { FastifyInstance } from "fastify";
import { getMcpTools, mcpStatus, startMcp } from "../agent/tools/mcp.js";

function summarize() {
  const servers = mcpStatus();
  const totalTools = servers.reduce((n, s) => n + s.toolCount, 0);
  // agentToolCount only counts tools on *connected* servers (what the agent
  // can actually call); it equals totalTools once error/disabled entries are 0.
  return { servers, totalTools, agentToolCount: getMcpTools().length };
}

export async function mcpRoutes(app: FastifyInstance) {
  // ── GET /api/mcp/servers ── current host status
  app.get("/api/mcp/servers", async () => {
    return { success: true, data: summarize() };
  });

  // ── POST /api/mcp/reload ── re-read mcp.json + reconnect
  app.post("/api/mcp/reload", async () => {
    await startMcp();
    return { success: true, data: summarize() };
  });
}
