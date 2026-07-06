// Omni as an MCP HOST. This is how Omni reaches Genspark-scale connector counts
// without hand-coding tools: connect to the MCP servers declared in mcp.json,
// discover each server's tools via listTools(), and wrap every one as an
// AgentTool so the Super Agent calls them exactly like the native tools.
//
// Safety model (mirrors secretary-tools.ts):
//   - A tool whose name reads as a mutation is kind "write_external" — the
//     orchestrator suspends for a confirmation card before running it.
//   - A tool whose name reads as an unambiguous read (get/list/search/…) runs
//     immediately.
//   - Safe by default: anything we can't classify is treated as a write.
//
// Everything here is DEFENSIVE. If the SDK import fails, no servers are
// configured, or a server is down, startMcp() is a no-op and getMcpTools()
// returns [] — boot never breaks and a dead server never throws.

import { logger } from "@omni/sdk";
import type { AgentTool, AgentToolCtx, ToolResult } from "./types.js";
// Type-only imports (erased at compile time → no runtime dependency on the SDK,
// so a broken/missing package can't crash module load). The runtime classes are
// pulled in lazily via dynamic import() inside startMcp().
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadMcpConfig, type McpServerConfig } from "../../lib/mcp-config.js";

// ─── tuning ──────────────────────────────────────────────────────────────────

const MCP_CALL_TIMEOUT_MS = 60_000;
const MAX_RESULT_CHARS = 8_000;

// ─── module-level registry ─────────────────────────────────────────────────────

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpServerEntry {
  config: McpServerConfig;
  client?: McpClient;
  transport?: Transport;
  tools: McpToolInfo[];
  status: "connected" | "error" | "disabled";
  error?: string;
}

const registry = new Map<string, McpServerEntry>();

// ─── read / write classifier ───────────────────────────────────────────────────
// MCP tool names are free-form (echo, add, read_file, getWeather, list-tables).
// Split on camelCase + separators, then: any write token → write; else a leading
// read verb → read; else write (safe default). Same spirit as composioToolKind.

const READ_VERBS = new Set([
  "get", "list", "search", "read", "fetch", "find", "query", "lookup", "describe",
  "view", "show", "count", "check", "preview", "retrieve", "browse", "inspect",
  "status", "info",
]);

const WRITE_VERBS = new Set([
  "create", "update", "delete", "send", "insert", "patch", "remove", "add", "write",
  "post", "put", "set", "upload", "cancel", "move", "clear", "archive", "trash",
  "publish", "replace", "rename", "duplicate", "enable", "disable", "reply", "draft",
  "merge", "execute", "run", "call", "apply", "install", "deploy", "kill", "stop",
  "start", "reboot", "restart", "modify", "edit", "append", "push", "commit",
  "destroy", "drop", "wipe", "purge", "reset", "make", "generate", "sync", "import",
  "export", "invoke", "trigger", "assign", "invite", "approve", "reject", "revoke",
  "grant",
]);

function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2") // camelCase → camel_Case
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

/** Safe-by-default read/write split for an MCP tool name. */
export function classifyMcpKind(toolName: string): "read" | "write_external" {
  const toks = tokenize(toolName);
  if (toks.some((t) => WRITE_VERBS.has(t))) return "write_external";
  if (toks.some((t) => READ_VERBS.has(t))) return "read";
  return "write_external";
}

/** `<server>__<tool>` sanitized to the model-callable charset [a-z0-9_], ≤64 chars. */
export function mcpToolAgentName(server: string, tool: string): string {
  const seg = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "x";
  return `${seg(server)}__${seg(tool)}`.slice(0, 64);
}

// ─── SDK loading (lazy + fail-soft) ─────────────────────────────────────────────

interface McpSdk {
  Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
  StdioClientTransport: typeof import("@modelcontextprotocol/sdk/client/stdio.js").StdioClientTransport;
  StreamableHTTPClientTransport: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
}

async function loadSdk(): Promise<McpSdk | null> {
  try {
    const [clientMod, stdioMod, httpMod] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    ]);
    return {
      Client: clientMod.Client,
      StdioClientTransport: stdioMod.StdioClientTransport,
      StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport,
    };
  } catch (err) {
    logger.warn(`[mcp] @modelcontextprotocol/sdk unavailable: ${(err as Error)?.message}`);
    return null;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────────

/** process.env (undefined values dropped) merged with the server's extra env. */
function mergeEnv(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") base[k] = v;
  }
  return { ...base, ...(extra ?? {}) };
}

function normalizeTools(raw: unknown): McpToolInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: McpToolInfo[] = [];
  for (const t of raw) {
    const rec = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
    if (typeof rec?.name !== "string" || !rec.name) continue;
    out.push({
      name: rec.name,
      description: typeof rec.description === "string" ? rec.description : undefined,
      inputSchema:
        rec.inputSchema && typeof rec.inputSchema === "object"
          ? (rec.inputSchema as Record<string, unknown>)
          : undefined,
    });
  }
  return out;
}

/**
 * Flatten an MCP callTool result to a string. MCP returns either
 * `{ content: [{type,text|...}], isError? }` or a legacy `{ toolResult }`.
 * We join text parts and describe non-text parts; structuredContent is a
 * fallback when there's no textual content.
 */
function stringifyMcpResult(res: unknown): { text: string; isError: boolean } {
  const r = res as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
    toolResult?: unknown;
  };
  const isError = r?.isError === true;

  if (Array.isArray(r?.content)) {
    const parts: string[] = [];
    for (const item of r.content as Array<Record<string, unknown>>) {
      if (!item || typeof item !== "object") continue;
      const type = item.type;
      if (type === "text" && typeof item.text === "string") {
        parts.push(item.text);
      } else if (type === "image") {
        parts.push(`[image ${String(item.mimeType ?? "")}]`.trim());
      } else if (type === "audio") {
        parts.push(`[audio ${String(item.mimeType ?? "")}]`.trim());
      } else if (type === "resource") {
        const resource = item.resource as Record<string, unknown> | undefined;
        if (resource && typeof resource.text === "string") parts.push(resource.text);
        else parts.push(`[resource ${String(resource?.uri ?? "")}]`.trim());
      } else if (type === "resource_link") {
        parts.push(`[resource_link ${String(item.uri ?? "")}]`.trim());
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    let text = parts.join("\n").trim();
    if (!text && r.structuredContent !== undefined) text = JSON.stringify(r.structuredContent);
    return { text: text || "(tool returned no content)", isError };
  }

  if (r?.toolResult !== undefined) {
    return {
      text: typeof r.toolResult === "string" ? r.toolResult : JSON.stringify(r.toolResult),
      isError,
    };
  }

  try {
    return { text: JSON.stringify(res) || "(tool returned no content)", isError };
  } catch {
    return { text: "(unserializable tool result)", isError };
  }
}

function cap(text: string): string {
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated)`
    : text;
}

// ─── AgentTool factory ──────────────────────────────────────────────────────────

function buildTool(server: string, client: McpClient, info: McpToolInfo): AgentTool {
  const toolName = info.name; // original name — this is what we call on the server
  const kind = classifyMcpKind(toolName);
  const parameters =
    info.inputSchema && typeof info.inputSchema === "object"
      ? info.inputSchema
      : { type: "object", properties: {} };

  const tool: AgentTool = {
    name: mcpToolAgentName(server, toolName),
    description: `[${server}] ${info.description ?? toolName}`.trim(),
    parameters,
    kind,
    maxResultChars: MAX_RESULT_CHARS,
    timeoutMs: MCP_CALL_TIMEOUT_MS,
    label: () => `${server}: ${toolName}`,
    async execute(args, ctx: AgentToolCtx): Promise<ToolResult> {
      try {
        // ctx.signal is the orchestrator's composed abort+timeout signal; we
        // also pass an explicit timeout so a hung server is bounded either way.
        const res = await client.callTool(
          { name: toolName, arguments: (args ?? {}) as Record<string, unknown> },
          undefined,
          { signal: ctx.signal, timeout: MCP_CALL_TIMEOUT_MS },
        );
        const { text, isError } = stringifyMcpResult(res);
        return { content: isError ? `MCP tool error: ${cap(text)}` : cap(text) };
      } catch (err) {
        // A real abort/timeout: let the orchestrator report it as such.
        if (ctx.signal.aborted) throw err;
        const msg = (err as Error)?.message ?? String(err);
        logger.warn(`[mcp] callTool ${server}/${toolName} failed: ${msg}`);
        return { content: `MCP tool error: ${msg.slice(0, 500)}` };
      }
    },
  };

  if (kind === "write_external") {
    tool.describe = async () =>
      `This runs the "${toolName}" action on the "${server}" MCP server. Review the arguments below before confirming — it may have side effects.`;
  }

  return tool;
}

// ─── lifecycle ──────────────────────────────────────────────────────────────────

async function connectServer(sdk: McpSdk, cfg: McpServerConfig): Promise<void> {
  try {
    let transport: Transport;
    if (cfg.transport === "stdio") {
      if (!cfg.command) throw new Error('stdio transport requires "command"');
      transport = new sdk.StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: mergeEnv(cfg.env),
      });
    } else {
      if (!cfg.url) throw new Error('http transport requires "url"');
      transport = new sdk.StreamableHTTPClientTransport(new URL(cfg.url));
    }

    const client = new sdk.Client({ name: "omni", version: "1.0" }, { capabilities: {} });
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = normalizeTools((listed as { tools?: unknown })?.tools);

    registry.set(cfg.name, { config: cfg, client, transport, tools, status: "connected" });
    logger.info(`[mcp] connected "${cfg.name}" (${cfg.transport}) — ${tools.length} tool(s)`);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    logger.warn(`[mcp] connect "${cfg.name}" failed: ${msg}`);
    registry.set(cfg.name, { config: cfg, tools: [], status: "error", error: msg });
  }
}

/**
 * Connect to every enabled MCP server from mcp.json and cache its tools.
 * Idempotent: closes any existing connections first, so it doubles as reload.
 * NEVER throws — a missing SDK, empty config, or dead server is logged and
 * boot proceeds.
 */
export async function startMcp(): Promise<void> {
  try {
    await stopMcp(); // clean slate (also serves /api/mcp/reload)

    const configs = loadMcpConfig();
    if (configs.length === 0) {
      logger.info("[mcp] no servers configured — MCP host idle");
      return;
    }

    const sdk = await loadSdk();
    if (!sdk) {
      logger.warn("[mcp] SDK unavailable — MCP host disabled");
      return;
    }

    for (const cfg of configs) {
      if (cfg.disabled) {
        registry.set(cfg.name, { config: cfg, tools: [], status: "disabled" });
        logger.info(`[mcp] "${cfg.name}" disabled — skipped`);
        continue;
      }
      await connectServer(sdk, cfg);
    }

    const connected = [...registry.values()].filter((e) => e.status === "connected");
    const toolCount = connected.reduce((n, e) => n + e.tools.length, 0);
    logger.info(
      `[mcp] host ready — ${connected.length}/${configs.length} server(s) connected, ${toolCount} tool(s)`,
    );
  } catch (err) {
    logger.warn(`[mcp] startMcp failed: ${(err as Error)?.message}`);
  }
}

/** Close every client (graceful shutdown / reload). Never throws. */
export async function stopMcp(): Promise<void> {
  const entries = [...registry.values()];
  registry.clear();
  await Promise.all(
    entries.map(async (e) => {
      try {
        await e.client?.close();
      } catch (err) {
        logger.warn(`[mcp] close "${e.config.name}" failed: ${(err as Error)?.message}`);
      }
    }),
  );
}

// ─── introspection ──────────────────────────────────────────────────────────────

export interface McpServerStatus {
  name: string;
  transport: McpServerConfig["transport"];
  status: McpServerEntry["status"];
  toolCount: number;
  error?: string;
}

/** Per-server status for the /api/mcp/servers route. */
export function mcpStatus(): McpServerStatus[] {
  return [...registry.values()].map((e) => ({
    name: e.config.name,
    transport: e.config.transport,
    status: e.status,
    toolCount: e.tools.length,
    ...(e.error ? { error: e.error } : {}),
  }));
}

/**
 * Every connected server's every tool, wrapped as an AgentTool. Empty when no
 * server is connected. The integrator splices this into getAgentToolsForUser().
 */
export function getMcpTools(): AgentTool[] {
  const tools: AgentTool[] = [];
  for (const entry of registry.values()) {
    if (entry.status !== "connected" || !entry.client) continue;
    for (const info of entry.tools) {
      tools.push(buildTool(entry.config.name, entry.client, info));
    }
  }
  return tools;
}
