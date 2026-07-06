// MCP host configuration loader. Omni becomes a Model Context Protocol *host*
// by connecting to the MCP *servers* declared in an `mcp.json` file, discovering
// their tools, and exposing them to the Super Agent. This module only READS that
// config; the actual connection lives in agent/tools/mcp.ts.
//
// Lookup order (first hit wins):
//   1. ${DATA_DIR}/mcp.json           — the durable, per-install location
//   2. ./mcp.json walking up from cwd — the repo-root convenience location
//      (same walk-up trick the migration runner uses, so it resolves from the
//      repo root, apps/api, or a package dir)
//
// loadMcpConfig() NEVER throws: a missing file, malformed JSON, or a bad server
// entry yields [] (or drops just the bad entry) so boot can't break on config.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, logger } from "@omni/sdk";

export type McpTransport = "stdio" | "http";

/** One MCP server entry from mcp.json. */
export interface McpServerConfig {
  /** Stable label; namespaces the server's tools as `<name>__<tool>`. */
  name: string;
  transport: McpTransport;
  /** stdio: the executable to spawn (e.g. "npx"). */
  command?: string;
  /** stdio: arguments for the executable. */
  args?: string[];
  /** stdio: extra env merged over process.env for the child. */
  env?: Record<string, string>;
  /** http: the Streamable HTTP endpoint URL. */
  url?: string;
  /** When true, the server is listed but not connected. */
  disabled?: boolean;
}

interface McpConfigFile {
  servers?: unknown;
}

/** Locate mcp.json: DATA_DIR first, then walk up from cwd (repo root). */
function findConfigFile(): string | undefined {
  const dataCandidate = path.join(DATA_DIR, "mcp.json");
  if (existsSync(dataCandidate) && statSync(dataCandidate).isFile()) {
    return dataCandidate;
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.resolve(dir, "mcp.json");
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    const parent = path.resolve(dir, "..");
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return undefined;
}

function asStringRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

/** Validate + normalize one entry. Returns undefined (with a warning) if unusable. */
function normalizeServer(raw: unknown): McpServerConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;

  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) {
    logger.warn("[mcp-config] skipping server with missing/empty name");
    return undefined;
  }

  const transport = r.transport === "http" ? "http" : r.transport === "stdio" ? "stdio" : undefined;
  if (!transport) {
    logger.warn(`[mcp-config] skipping "${name}": transport must be "stdio" or "http"`);
    return undefined;
  }

  const cfg: McpServerConfig = { name, transport };

  if (transport === "stdio") {
    if (typeof r.command !== "string" || !r.command.trim()) {
      logger.warn(`[mcp-config] skipping "${name}": stdio transport requires a "command"`);
      return undefined;
    }
    cfg.command = r.command.trim();
    cfg.args = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === "string") : [];
    const env = asStringRecord(r.env);
    if (env) cfg.env = env;
  } else {
    if (typeof r.url !== "string" || !r.url.trim()) {
      logger.warn(`[mcp-config] skipping "${name}": http transport requires a "url"`);
      return undefined;
    }
    cfg.url = r.url.trim();
  }

  if (r.disabled === true) cfg.disabled = true;
  return cfg;
}

/**
 * Load the configured MCP servers. Returns [] when no config file exists or the
 * file is invalid; drops (with a warning) any individual malformed entry. Never
 * throws — a broken mcp.json must never take down API boot.
 */
export function loadMcpConfig(): McpServerConfig[] {
  try {
    const file = findConfigFile();
    if (!file) return [];

    let parsed: McpConfigFile;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as McpConfigFile;
    } catch (err) {
      logger.warn(`[mcp-config] failed to parse ${file}: ${(err as Error)?.message}`);
      return [];
    }

    const rawServers = Array.isArray(parsed?.servers) ? parsed.servers : [];
    const seen = new Set<string>();
    const servers: McpServerConfig[] = [];
    for (const raw of rawServers) {
      const cfg = normalizeServer(raw);
      if (!cfg) continue;
      if (seen.has(cfg.name)) {
        logger.warn(`[mcp-config] duplicate server name "${cfg.name}" — keeping the first`);
        continue;
      }
      seen.add(cfg.name);
      servers.push(cfg);
    }

    logger.info(`[mcp-config] loaded ${servers.length} server(s) from ${file}`);
    return servers;
  } catch (err) {
    logger.warn(`[mcp-config] loadMcpConfig failed: ${(err as Error)?.message}`);
    return [];
  }
}
