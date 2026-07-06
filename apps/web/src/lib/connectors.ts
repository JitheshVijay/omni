// Typed client for the connector store (Composio managed OAuth) over authFetch.
// The catalog + per-app status come from GET /api/connectors (read via useApi on
// the page); these helpers cover connect / refresh / disconnect. A not-configured
// backend surfaces as configured:false on the list and a ParsedApiError with code
// "connectors_unconfigured" on connect/refresh.

import { authFetch } from "@/lib/use-api";

export const CONNECTOR_CATEGORIES = [
  "Communication",
  "Docs & Notes",
  "Dev",
  "CRM & Sales",
  "Productivity",
  "Social",
] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

export type ConnectorStatus = "active" | "pending" | "disconnected" | "error" | "none";

export interface Connector {
  toolkit: string;
  name: string;
  description: string;
  category: ConnectorCategory;
  icon?: string;
  status: ConnectorStatus;
}

export interface ConnectorsResponse {
  configured: boolean;
  connectors: Connector[];
}

export const CONNECTORS_PATH = "/api/connectors";

export function listConnectors(): Promise<ConnectorsResponse> {
  return authFetch<ConnectorsResponse>(CONNECTORS_PATH);
}

export function connectConnector(toolkit: string): Promise<{ redirectUrl: string }> {
  return authFetch<{ redirectUrl: string }>(`/api/connectors/${toolkit}/connect`, {
    method: "POST",
  });
}

export function refreshConnector(
  toolkit: string,
): Promise<{ toolkit: string; status: ConnectorStatus }> {
  return authFetch<{ toolkit: string; status: ConnectorStatus }>(
    `/api/connectors/${toolkit}/refresh`,
    { method: "POST" },
  );
}

export function disconnectConnector(toolkit: string): Promise<{ ok: boolean }> {
  return authFetch<{ ok: boolean }>(`/api/connectors/${toolkit}`, { method: "DELETE" });
}

// ── MCP servers (read-only display, best-effort) ────────────────────────────
// The Connectors page also surfaces configured MCP servers when the endpoint
// exists. It may not be present yet, so callers guard with try/catch.
export interface McpServerInfo {
  name: string;
  status?: string;
  toolCount?: number;
}

export function listMcpServers(): Promise<{ servers: McpServerInfo[] }> {
  return authFetch<{ servers: McpServerInfo[] }>("/api/mcp/servers");
}
