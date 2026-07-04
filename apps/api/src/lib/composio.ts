// Composio integration layer for the AI Secretary — Gmail + Google Calendar as
// agent tools behind Composio-managed OAuth. One key (COMPOSIO_API_KEY) and NO
// per-app dashboard setup: Auth Configs are resolved (and lazily created with
// Composio-managed auth) on demand, so a toolkit is connectable without adding
// env vars or provider credentials.
//
// NO-OP until COMPOSIO_API_KEY is set: every exported function returns an
// "unavailable"/empty shape and NEVER throws when the key is absent. Adapted
// from Flo101's lib/composio.ts, scoped to the single local user and the two
// Secretary toolkits, with the org logic and non-OAuth credential flow dropped.

import { Composio } from "@composio/core";
import type OpenAI from "openai";
import { logger, nowISO, all, run as dbRun, uuid } from "@omni/sdk";

const env = process.env;

// The toolkits the Secretary manages. Everything else is out of scope.
export const SECRETARY_TOOLKITS = ["gmail", "googlecalendar"] as const;
export type SecretaryToolkit = (typeof SECRETARY_TOOLKITS)[number];

export function isSecretaryToolkit(x: string): x is SecretaryToolkit {
  return (SECRETARY_TOOLKITS as readonly string[]).includes(x);
}

export function composioEnabled(): boolean {
  return !!env.COMPOSIO_API_KEY;
}

// Lazy singleton — only constructed when the key exists.
let client: Composio | null = null;
function composio(): Composio | null {
  if (!composioEnabled()) return null;
  if (!client) client = new Composio({ apiKey: env.COMPOSIO_API_KEY });
  return client;
}

// ─── read / write classifier ────────────────────────────────────────────────
// Composio tool slugs are UPPERCASE_UNDERSCORED (GMAIL_SEND_EMAIL). A tool runs
// immediately (kind "read") ONLY when its leading verb is an unambiguous read
// AND no mutation token appears anywhere in the slug; everything else is a WRITE
// staged for a confirmation card. Safe-by-default: the whole point of the
// Secretary is that no email is sent / no event created without confirmation.

const READ_VERBS = new Set([
  "GET", "FETCH", "LIST", "SEARCH", "FIND", "READ", "RETRIEVE", "COUNT",
  "CHECK", "COMPARE", "DESCRIBE", "SHOW", "VIEW", "DOWNLOAD", "PREVIEW",
]);

// If ANY of these appears as a slug segment the tool is a write even when its
// leading verb looks like a read — the critical guard against idempotent
// upserts (GET_OR_CREATE_*, FIND_OR_CREATE_*) firing unconfirmed.
const WRITE_TOKENS = new Set([
  "CREATE", "UPDATE", "DELETE", "SEND", "INSERT", "PATCH", "REMOVE", "ADD", "MOVE",
  "IMPORT", "CLEAR", "ARCHIVE", "TRASH", "POST", "PUT", "SET", "ENABLE", "DISABLE",
  "UPLOAD", "CANCEL", "ACCEPT", "DECLINE", "INVITE", "ASSIGN", "CLOSE", "REOPEN",
  "REVOKE", "GRANT", "PUBLISH", "REPLACE", "RENAME", "DUPLICATE", "WRITE", "WATCH",
  "REPLY", "DRAFT", "MERGE", "STAR", "FORK", "COMMENT", "APPROVE", "REJECT", "MARK",
]);

/** A Composio slug is UPPERCASE_UNDERSCORED; native Omni tools are snake_case. */
export function isComposioToolName(name: string): boolean {
  return /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(name);
}

/** Safe-by-default read/write split for a Composio tool slug. */
export function composioToolKind(name: string): "read" | "write" {
  const segs = name.split("_");
  if (segs.some((s) => WRITE_TOKENS.has(s))) return "write";
  return READ_VERBS.has(segs[1] ?? "") ? "read" : "write";
}

/** Human label for an action card: GMAIL_SEND_EMAIL → "Gmail: send email". */
export function describeComposioAction(name: string): string {
  const [toolkit, ...rest] = name.split("_");
  const app = toolkit ? toolkit.charAt(0) + toolkit.slice(1).toLowerCase() : "App";
  const nice = app.toLowerCase() === "googlecalendar" ? "Calendar" : app;
  const action = rest.join(" ").toLowerCase() || "run action";
  return `${nice}: ${action}`;
}

// ─── self-heal classification (inlined, minimal) ─────────────────────────────
// Conservative: only matches signatures we understand so we never "recover" a
// genuine success. Reads/writes both retry only on a not-active connection race
// (nothing was sent) or an upstream rate-limit/5xx.

function classifyComposioResult(resultJson: string): string | null {
  let s: string;
  try {
    s = resultJson.toLowerCase();
  } catch {
    return null;
  }
  if (s.includes("composio_not_configured")) return "not_configured";
  if (
    /not connected|no connected account|could not find a connection|connection not found|no active connection/.test(s)
  )
    return "connection_not_active";
  if (/rate.?limit|"?429"?|too many requests/.test(s)) return "rate_limited";
  if (/\b5\d\d\b|internal server error|gateway timeout|temporarily unavailable|econnreset|etimedout/.test(s))
    return "transient_upstream";
  return null;
}

/** Whether a tool result JSON represents success (so we skip healing). */
function composioResultLooksOk(resultJson: string): boolean {
  try {
    const r = JSON.parse(resultJson) as { successful?: boolean; error?: unknown };
    if (typeof r?.successful === "boolean") return r.successful;
    return r?.error == null;
  } catch {
    return true; // unparseable but non-empty → assume the caller handles it
  }
}

// ─── Auth Config resolution ──────────────────────────────────────────────────
// An Auth Config (ac_…) is required to start a connect flow. We resolve it at
// connect time: reuse an existing config for the toolkit → else create one with
// Composio-managed auth (Composio supplies the OAuth app, no own credentials).

const AC_OK_TTL_MS = 60 * 60 * 1000;
const AC_MISS_TTL_MS = 5 * 60 * 1000;
const acCache = new Map<string, { id: string | null; exp: number }>();
const acInflight = new Map<string, Promise<string | null>>();

async function resolveAuthConfigId(app: string): Promise<string | null> {
  const slug = app.toLowerCase();
  const cached = acCache.get(slug);
  if (cached && cached.exp > Date.now()) return cached.id;
  const inflight = acInflight.get(slug);
  if (inflight) return inflight;

  const p = (async (): Promise<string | null> => {
    const c = composio();
    if (!c) return null;
    try {
      const listed = (await c.authConfigs.list({ toolkit: slug, limit: 1 })) as {
        items?: Array<{ id?: string }>;
      };
      let id = listed?.items?.[0]?.id ?? null;
      if (id) {
        logger.info(`[composio] reusing auth config ${id} for ${slug}`);
      } else {
        const created = (await c.authConfigs.create(slug, {
          type: "use_composio_managed_auth",
        } as Parameters<typeof c.authConfigs.create>[1])) as { id?: string };
        id = created?.id ?? null;
        logger.info(`[composio] created managed auth config for ${slug}: ${id ?? "(none)"}`);
      }
      acCache.set(slug, { id, exp: Date.now() + (id ? AC_OK_TTL_MS : AC_MISS_TTL_MS) });
      return id;
    } catch (err) {
      logger.warn(`[composio] resolve auth config for ${slug} failed: ${(err as Error)?.message}`);
      acCache.set(slug, { id: null, exp: Date.now() + AC_MISS_TTL_MS });
      return null;
    } finally {
      acInflight.delete(slug);
    }
  })();
  acInflight.set(slug, p);
  return p;
}

// ─── connections table helpers ───────────────────────────────────────────────

export interface ConnectionRow {
  toolkit: string;
  connected_account_id: string | null;
  status: "pending" | "active" | "error" | "disconnected";
  status_detail: string | null;
}

// Map a Composio account status to our four-state column.
function mapStatus(raw: string | undefined): ConnectionRow["status"] {
  switch (String(raw ?? "").toUpperCase()) {
    case "ACTIVE":
      return "active";
    case "INITIATED":
    case "INITIALIZING":
    case "PENDING":
      return "pending";
    case "FAILED":
    case "EXPIRED":
    case "INACTIVE":
    case "DELETED":
      return "error";
    default:
      return "pending";
  }
}

function upsertConnection(
  userId: string,
  toolkit: string,
  patch: {
    connected_account_id?: string | null;
    status: ConnectionRow["status"];
    status_detail?: string | null;
  },
): void {
  dbRun(
    `INSERT INTO connections (id, user_id, toolkit, connected_account_id, status, status_detail, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, toolkit) DO UPDATE SET
       connected_account_id = COALESCE(excluded.connected_account_id, connections.connected_account_id),
       status = excluded.status,
       status_detail = excluded.status_detail,
       updated_at = excluded.updated_at`,
    uuid(),
    userId,
    toolkit,
    patch.connected_account_id ?? null,
    patch.status,
    patch.status_detail ?? null,
    nowISO(),
    nowISO(),
  );
}

/** Our stored connection rows for the user (source of truth for the UI). */
export function listConnections(userId: string): ConnectionRow[] {
  return all<ConnectionRow>(
    `SELECT toolkit, connected_account_id, status, status_detail
       FROM connections WHERE user_id = ? ORDER BY toolkit ASC`,
    userId,
  );
}

// ─── Composio account introspection ──────────────────────────────────────────

function accountToolkit(a: Record<string, unknown>): string {
  const tk = a.toolkit as { slug?: string } | string | undefined;
  return (typeof tk === "string" ? tk : (tk?.slug ?? (a.appName as string) ?? "")).toString().toLowerCase();
}
function accountId(a: Record<string, unknown>): string | null {
  return (a.id as string) ?? (a.connectedAccountId as string) ?? null;
}
function accountStatus(a: Record<string, unknown>): string | undefined {
  return (a.status as string) ?? undefined;
}

async function listUserAccounts(userId: string): Promise<Array<Record<string, unknown>>> {
  const c = composio();
  if (!c) return [];
  try {
    const res = (await c.connectedAccounts.list({ userIds: [userId] })) as unknown;
    return (Array.isArray(res) ? res : ((res as { items?: unknown[] })?.items ?? [])) as Array<
      Record<string, unknown>
    >;
  } catch (err) {
    logger.warn(`[composio] list accounts failed: ${(err as Error)?.message}`);
    return [];
  }
}

// ─── Connect (managed OAuth) ─────────────────────────────────────────────────

export interface ConnectResult {
  status: "ok" | "unavailable";
  redirectUrl?: string;
}

/**
 * Begin a managed-OAuth connect flow for a toolkit → the hosted redirect URL.
 * Records a `pending` connection row. Returns {status:"unavailable"} (never
 * throws) when Composio is off or no redirect could be produced.
 */
export async function connectToolkit(
  userId: string,
  toolkit: string,
  callbackUrl?: string,
): Promise<ConnectResult> {
  const c = composio();
  if (!c) return { status: "unavailable" };
  const slug = toolkit.toLowerCase();
  const acId = await resolveAuthConfigId(slug);
  if (!acId) return { status: "unavailable" };
  try {
    const conn = (await c.connectedAccounts.link(
      userId,
      acId,
      callbackUrl ? { callbackUrl } : undefined,
    )) as { redirectUrl?: string | null; id?: string };
    const url = conn?.redirectUrl ?? null;
    if (!url) {
      logger.warn(`[composio] connect ${slug}: link() returned no redirectUrl`);
      return { status: "unavailable" };
    }
    upsertConnection(userId, slug, {
      connected_account_id: conn?.id ?? null,
      status: "pending",
      status_detail: "Awaiting authorization",
    });
    return { status: "ok", redirectUrl: url };
  } catch (err) {
    logger.warn(`[composio] connect ${slug} failed: ${(err as Error)?.message}`);
    return { status: "unavailable" };
  }
}

/**
 * Re-check a toolkit's status against Composio and upsert our row. Returns the
 * refreshed row, or the existing row (or a synthetic pending) when Composio is
 * off / the account isn't visible yet. Never throws.
 */
export async function connectionStatus(userId: string, toolkit: string): Promise<ConnectionRow> {
  const slug = toolkit.toLowerCase();
  const existing = listConnections(userId).find((r) => r.toolkit === slug);
  if (!composioEnabled()) {
    return existing ?? { toolkit: slug, connected_account_id: null, status: "disconnected", status_detail: null };
  }
  const accounts = await listUserAccounts(userId);
  const match = accounts.find((a) => accountToolkit(a) === slug);
  if (!match) {
    // No account visible. Keep an existing row as-is; otherwise report pending.
    return existing ?? { toolkit: slug, connected_account_id: null, status: "pending", status_detail: null };
  }
  const status = mapStatus(accountStatus(match));
  const id = accountId(match);
  const detail = status === "active" ? null : (accountStatus(match) ?? null);
  upsertConnection(userId, slug, { connected_account_id: id, status, status_detail: detail });
  if (status === "active") invalidateToolsCache(userId);
  return { toolkit: slug, connected_account_id: id, status, status_detail: detail };
}

/**
 * Disconnect a toolkit: delete the Composio connected account (best-effort) and
 * mark our row disconnected. Never throws.
 */
export async function disconnectToolkit(userId: string, toolkit: string): Promise<{ ok: boolean }> {
  const slug = toolkit.toLowerCase();
  const c = composio();
  const row = listConnections(userId).find((r) => r.toolkit === slug);
  if (c) {
    try {
      // Prefer the stored id; else look one up from Composio.
      let id = row?.connected_account_id ?? null;
      if (!id) {
        const accounts = await listUserAccounts(userId);
        id = accountId(accounts.find((a) => accountToolkit(a) === slug) ?? {}) ?? null;
      }
      if (id) await c.connectedAccounts.delete(id);
    } catch (err) {
      logger.warn(`[composio] disconnect ${slug} failed: ${(err as Error)?.message}`);
    }
  }
  dbRun(
    `UPDATE connections SET status = 'disconnected', connected_account_id = NULL,
       status_detail = NULL, updated_at = ? WHERE user_id = ? AND toolkit = ?`,
    nowISO(),
    userId,
    slug,
  );
  invalidateToolsCache(userId);
  return { ok: true };
}

// ─── Agent tool provider ─────────────────────────────────────────────────────

// Cache the per-user tool set briefly so we don't re-hit Composio each turn.
// A newly-connected toolkit appears within the TTL. Keyed by user + toolkit set.
const TOOLS_TTL_MS = 60 * 1000;
const toolsCache = new Map<string, { tools: OpenAI.ChatCompletionTool[]; exp: number }>();

/** Drop a user's cached tool set (called on connect/disconnect/activation). */
export function invalidateToolsCache(userId: string): void {
  for (const key of [...toolsCache.keys()]) {
    if (key.startsWith(`${userId}::`)) toolsCache.delete(key);
  }
}

/**
 * The user's Secretary tools as OpenAI function-calling tools. `important:true`
 * loads Composio's curated high-value set (~40/app) rather than the alphabetic
 * default (which misses the common reads/writes). Empty when Composio is off or
 * no toolkits are given. Never throws.
 */
export async function composioToolsForUser(
  userId: string,
  toolkits: string[],
): Promise<OpenAI.ChatCompletionTool[]> {
  const c = composio();
  if (!c || toolkits.length === 0) return [];
  const slugs = [...new Set(toolkits.map((t) => t.toLowerCase()))].sort();
  const cacheKey = `${userId}::${slugs.join(",")}`;
  const cached = toolsCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) return cached.tools;

  const perApp = Math.min(40, Math.max(12, Math.floor(64 / slugs.length)));
  const tools: OpenAI.ChatCompletionTool[] = [];
  for (const tk of slugs) {
    try {
      const getOpts = { toolkits: [tk], important: true, limit: perApp };
      const t = (await c.tools.get(userId, getOpts)) as unknown as OpenAI.ChatCompletionTool[];
      if (Array.isArray(t)) tools.push(...t);
    } catch (err) {
      logger.warn(`[composio] tools.get ${tk} failed: ${(err as Error)?.message}`);
    }
  }
  toolsCache.set(cacheKey, { tools, exp: Date.now() + TOOLS_TTL_MS });
  return tools;
}

/**
 * Execute a Composio tool by slug (both read and write paths — the confirmation
 * gate lives in the orchestrator). Returns a result JSON string. Self-heals a
 * not-active-connection race (bust cache + retry once — nothing was sent) and a
 * transient rate-limit/5xx. Returns an error envelope string, never throws.
 */
export async function executeComposioTool(
  userId: string,
  slug: string,
  args: Record<string, unknown>,
): Promise<string> {
  const c = composio();
  if (!c) return JSON.stringify({ error: "composio_not_configured" });

  // dangerouslySkipVersionCheck: without it tools.execute throws
  // ComposioToolVersionRequiredError since we pin no toolkit version.
  const runOnce = async (): Promise<string> => {
    const res = await c.tools.execute(slug, {
      userId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
    });
    const r = res as { successful?: boolean };
    logger.info(
      `[composio] exec ${slug} ok=${r?.successful} → ${JSON.stringify(res).slice(0, 400)}`,
    );
    return JSON.stringify(res);
  };

  try {
    const out = await runOnce();
    if (composioResultLooksOk(out)) return out;
    const symptom = classifyComposioResult(out);
    if (symptom === "connection_not_active" || symptom === "rate_limited" || symptom === "transient_upstream") {
      if (symptom === "connection_not_active") invalidateToolsCache(userId);
      const retry = await runOnce().catch(() => out);
      return composioResultLooksOk(retry) ? retry : out;
    }
    return out;
  } catch (err) {
    logger.warn(`[composio] exec ${slug} threw: ${(err as Error)?.message}`);
    return JSON.stringify({
      error: "composio_execution_failed",
      message: (err as Error)?.message?.slice(0, 200),
    });
  }
}
