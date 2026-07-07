// Hand-written agent tools. update_plan and ask_user carry a schema/label
// but no execute() — the orchestrator intercepts them by name (update_plan
// rewrites the run's plan; ask_user suspends for a question card). The rest
// execute normally.
import { lookup } from "node:dns/promises";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DATA_DIR,
  MODELS,
  all,
  embedText,
  fetchUrlArticle,
  getExaContents,
  logger,
  nowISO,
  one,
  openai,
  run,
  searchExa,
  uuid,
} from "@omni/sdk";
import { extractText } from "../../lib/extract-text.js";
import { searchHubMemory } from "../../lib/hub-memory.js";
import type { AgentTool, AgentToolCtx, ToolResult } from "./types.js";

// Strip NUL/C0/C1 control chars (keep tab/newline/CR) that would corrupt
// the model's context.
function sanitize(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) {
      out += s[i];
      continue;
    }
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue;
    out += s[i];
  }
  return out.trim();
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

function int(args: Record<string, unknown>, key: string, dflt: number): number {
  const v = args[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : dflt;
}

function num(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

// Format a number for display, trimming binary-float noise (e.g. 0.30000000004).
function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const rounded = Math.round(n * 1e10) / 1e10;
  return String(rounded);
}

// fetch() that both honours the run's abort signal and a per-call timeout, and
// sends a UA (some public APIs, e.g. Wikipedia, 403 without one).
async function guardedFetch(
  url: string,
  ctx: AgentToolCtx,
  timeoutMs = 15_000,
  init: RequestInit = {},
): Promise<Response> {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; OmniBot/1.0)", ...(init.headers ?? {}) };
  // Follow redirects MANUALLY, re-running the SSRF gate on the initial URL and
  // every redirect target. fetch's default redirect:"follow" would silently
  // chase a 3xx to an internal address (169.254.169.254, 127.0.0.1, the local
  // API port), defeating a guard that only ran on the first URL.
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    await assertSafeUrl(current);
    const res = await fetch(current, { ...init, signal, headers, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get("location");
    if (!loc) return res;
    void res.body?.cancel().catch(() => {});
    current = new URL(loc, current).toString();
  }
  throw new Error("too many redirects");
}

// ─── update_plan (intercepted) ──────────────────────────────────────

export const updatePlanTool: AgentTool = {
  name: "update_plan",
  description:
    "Create or replace your task plan — a full-replacement checklist of steps. Call this FIRST to lay out your plan, then again to mark each step in_progress/done/failed as you work. Always send the COMPLETE plan, not a diff.",
  parameters: {
    type: "object",
    properties: {
      plan: {
        type: "array",
        description: "The complete ordered checklist.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable id for the step (keep it across updates)." },
            title: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "done", "failed", "skipped"],
            },
            note: { type: "string" },
          },
          required: ["title", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["plan"],
    additionalProperties: false,
  },
  kind: "write_internal",
  label: () => "Updating the plan",
};

export interface PlanItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done" | "failed" | "skipped";
  note?: string;
}

const PLAN_STATUSES = new Set(["pending", "in_progress", "done", "failed", "skipped"]);

/** Validate + normalize an update_plan payload. Throws on a bad shape. */
export function normalizePlan(raw: unknown): PlanItem[] {
  const arr = (raw as { plan?: unknown })?.plan ?? raw;
  if (!Array.isArray(arr)) throw new Error("plan must be an array");
  return arr.map((it, i) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) throw new Error(`plan[${i}].title is required`);
    const status = typeof o.status === "string" && PLAN_STATUSES.has(o.status) ? o.status : "pending";
    const item: PlanItem = {
      id: typeof o.id === "string" && o.id ? o.id : `step-${i + 1}`,
      title,
      status: status as PlanItem["status"],
    };
    if (typeof o.note === "string" && o.note.trim()) item.note = o.note.trim();
    return item;
  });
}

// ─── ask_user (intercepted, suspending) ─────────────────────────────

export const askUserTool: AgentTool = {
  name: "ask_user",
  description:
    "Pause and ask the user a clarifying question when you genuinely cannot proceed without their input. Use sparingly — prefer reasonable assumptions. The run suspends until they answer.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string" },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "Optional suggested answers.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  kind: "read",
  label: (args) => `Asking: ${str(args, "question").slice(0, 80)}`,
};

// ─── web_search ─────────────────────────────────────────────────────

async function webSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const query = str(args, "query");
  if (!query.trim()) return { content: "No query provided." };
  const numResults = Math.min(Math.max(int(args, "num_results", 5), 1), 8);

  // Primary: Exa search -> contents (700 chars/result), stitched.
  const results = await searchExa(query, { numResults });
  if (results.length > 0) {
    const urls = results.map((r) => r.url).slice(0, numResults);
    const contents = await getExaContents(urls, { maxCharactersPerUrl: 700 });
    const byUrl = new Map(contents.map((c) => [c.url, c.text]));
    const blocks = results.slice(0, numResults).map((r, i) => {
      const body = byUrl.get(r.url) ?? r.snippet ?? "";
      return `[${i + 1}] ${r.title}\n${r.url}\n${sanitize(body).slice(0, 700)}`;
    });
    return { content: `Search results for "${query}":\n\n${blocks.join("\n\n")}` };
  }

  // Fallback: OpenRouter :online model reads the web; harvest url_citation
  // annotations for source attribution.
  try {
    const resp = (await openai.chat.completions.create({
      model: MODELS.cheap_online,
      messages: [
        {
          role: "system",
          content:
            "Answer the user's search query concisely from current web results. End with a short list of the source URLs you used.",
        },
        { role: "user", content: query },
      ],
      max_tokens: 700,
    } as never)) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          annotations?: Array<{ type?: string; url_citation?: { url?: string; title?: string } }>;
        };
      }>;
    };
    const msg = resp.choices?.[0]?.message;
    const text = sanitize(msg?.content ?? "");
    const cites = (msg?.annotations ?? [])
      .filter((a) => a.type === "url_citation" && a.url_citation?.url)
      .map((a, i) => `[${i + 1}] ${a.url_citation?.title ?? ""} ${a.url_citation?.url}`.trim());
    const sources = cites.length > 0 ? `\n\nSources:\n${cites.join("\n")}` : "";
    if (!text) return { content: `No web results found for "${query}".` };
    return { content: `Web answer for "${query}":\n\n${text}${sources}` };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[web_search] online fallback failed");
    return { content: `Web search is currently unavailable for "${query}".` };
  }
}

export const webSearchTool: AgentTool = {
  name: "web_search",
  description:
    "Search the web for current information and return the top results with short excerpts. Use it whenever the answer depends on recent, external, or factual information you should verify.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      num_results: { type: "integer", description: "1-8, default 5." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  kind: "read",
  maxResultChars: 8000,
  label: (args) => `Searching the web for "${str(args, "query").slice(0, 60)}"`,
  execute: webSearch,
};

// ─── fetch_url ──────────────────────────────────────────────────────

const FETCH_PAGE = 12_000;

async function fetchUrl(args: Record<string, unknown>): Promise<ToolResult> {
  const url = str(args, "url");
  if (!/^https?:\/\//i.test(url)) return { content: "Provide a valid http(s) URL." };
  const offset = Math.max(int(args, "offset_chars", 0), 0);
  const article = await fetchUrlArticle(url);
  if (!article) {
    return { content: `Could not extract readable content from ${url} (paywalled, JS-rendered, or not an article).` };
  }
  const full = sanitize(article.text);
  const slice = full.slice(offset, offset + FETCH_PAGE);
  const truncated = offset + FETCH_PAGE < full.length;
  const meta = truncated
    ? `\n\n[truncated — ${full.length - (offset + FETCH_PAGE)} more chars; call again with offset_chars=${offset + FETCH_PAGE}]`
    : "";
  return { content: `# ${article.title}\n(${url})\n\n${slice}${meta}` };
}

export const fetchUrlTool: AgentTool = {
  name: "fetch_url",
  description:
    "Fetch a web page and return its readable article text. Supports pagination via offset_chars for long pages.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      offset_chars: { type: "integer", description: "Start offset for long pages (default 0)." },
    },
    required: ["url"],
    additionalProperties: false,
  },
  kind: "read",
  maxResultChars: 13_000,
  label: (args) => `Reading ${str(args, "url").slice(0, 80)}`,
  execute: fetchUrl,
};

// ─── youtube_transcript ─────────────────────────────────────────────

function youtubeId(input: string): string | null {
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const u = new URL(input);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1, 12) || null;
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = /\/(embed|shorts)\/([\w-]{11})/.exec(u.pathname);
    if (m) return m[2];
  } catch {
    /* not a url */
  }
  return null;
}

async function youtubeTranscript(args: Record<string, unknown>): Promise<ToolResult> {
  const raw = str(args, "url") || str(args, "video_id");
  const id = youtubeId(raw);
  if (!id) return { content: "Provide a valid YouTube URL or 11-character video id." };
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OmniBot/1.0)", "Accept-Language": "en" },
      signal: AbortSignal.timeout(15_000),
    });
    const html = await pageRes.text();
    const m = /"captionTracks":(\[.*?\])/.exec(html);
    if (!m) {
      return { content: "No transcript is available for this video (captions disabled or not found)." };
    }
    const tracks = JSON.parse(m[1]) as Array<{ baseUrl?: string; languageCode?: string }>;
    const track = tracks.find((t) => t.languageCode?.startsWith("en")) ?? tracks[0];
    if (!track?.baseUrl) return { content: "No transcript track found for this video." };
    const xmlRes = await fetch(track.baseUrl, { signal: AbortSignal.timeout(15_000) });
    const xml = await xmlRes.text();
    const lines = [...xml.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((mm) =>
      mm[1]
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/<[^>]+>/g, ""),
    );
    const text = sanitize(lines.join(" "));
    if (!text) return { content: "The transcript was empty." };
    return { content: `Transcript for youtube video ${id}:\n\n${text.slice(0, FETCH_PAGE)}` };
  } catch (err) {
    logger.warn({ err: (err as Error).message, id }, "[youtube_transcript] failed");
    return {
      content:
        "Could not fetch the YouTube transcript (network error or the video has no captions). Try summarizing from a web_search instead.",
    };
  }
}

export const youtubeTranscriptTool: AgentTool = {
  name: "youtube_transcript",
  description: "Fetch the English transcript/captions of a YouTube video by URL or id.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "YouTube URL." },
      video_id: { type: "string", description: "11-character video id (alternative to url)." },
    },
    additionalProperties: false,
  },
  kind: "read",
  maxResultChars: 13_000,
  label: () => "Fetching YouTube transcript",
  execute: youtubeTranscript,
};

// ─── drive_list ─────────────────────────────────────────────────────

interface DriveRow {
  id: string;
  name: string;
  mime: string;
  size_bytes: number;
  rel_path: string;
  index_status: string;
}

async function driveList(args: Record<string, unknown>, ctx: AgentToolCtx): Promise<ToolResult> {
  const q = str(args, "query").trim();
  let sql = "SELECT id, name, mime, size_bytes, rel_path, index_status FROM drive_files WHERE user_id = ?";
  const params: unknown[] = [ctx.userId];
  if (q) {
    sql += " AND name LIKE ? ESCAPE '\\'";
    params.push(`%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`);
  }
  sql += " ORDER BY created_at DESC LIMIT 100";
  const rows = all<DriveRow>(sql, ...params);
  if (rows.length === 0) return { content: q ? `No Drive files match "${q}".` : "The Drive is empty." };
  const list = rows.map((r) => `- ${r.name} (id=${r.id}, ${r.mime}, ${r.size_bytes}B, ${r.index_status})`);
  return { content: `Drive files:\n${list.join("\n")}` };
}

export const driveListTool: AgentTool = {
  name: "drive_list",
  description: "List the user's Drive files, optionally filtered by a name substring. Returns ids to pass to drive_read.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Optional name filter." } },
    additionalProperties: false,
  },
  kind: "read",
  label: (args) => (str(args, "query") ? `Listing Drive files matching "${str(args, "query")}"` : "Listing Drive files"),
  execute: driveList,
};

// ─── drive_read ─────────────────────────────────────────────────────

async function driveRead(args: Record<string, unknown>, ctx: AgentToolCtx): Promise<ToolResult> {
  const fileId = str(args, "file_id");
  if (!fileId) return { content: "Provide a file_id (use drive_list to find one)." };
  const offset = Math.max(int(args, "offset_chars", 0), 0);
  const file = one<DriveRow & { name: string }>(
    "SELECT id, name, mime, size_bytes, rel_path, index_status FROM drive_files WHERE id = ? AND user_id = ?",
    fileId,
    ctx.userId,
  );
  if (!file) return { content: "File not found." };
  let extracted: string;
  try {
    const res = await extractText(join(DATA_DIR, file.rel_path), file.mime, file.name);
    if (!res) return { content: `"${file.name}" is a ${file.mime} file with no extractable text.` };
    extracted = "pages" in res ? res.pages.map((p) => p.text).join("\n\n") : res.flatText;
  } catch (err) {
    return { content: `Could not read "${file.name}": ${(err as Error).message}` };
  }
  const full = sanitize(extracted);
  const slice = full.slice(offset, offset + FETCH_PAGE);
  const truncated = offset + FETCH_PAGE < full.length;
  const meta = truncated
    ? `\n\n[truncated — call again with offset_chars=${offset + FETCH_PAGE}]`
    : "";
  return { content: `Contents of "${file.name}":\n\n${slice}${meta}` };
}

export const driveReadTool: AgentTool = {
  name: "drive_read",
  description: "Read the extracted text of a Drive file by id, with offset_chars pagination for long files.",
  parameters: {
    type: "object",
    properties: {
      file_id: { type: "string" },
      offset_chars: { type: "integer", description: "Start offset (default 0)." },
    },
    required: ["file_id"],
    additionalProperties: false,
  },
  kind: "read",
  maxResultChars: 13_000,
  label: () => "Reading a Drive file",
  execute: driveRead,
};

// ─── drive_write ────────────────────────────────────────────────────

const WRITE_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
};

async function driveWrite(args: Record<string, unknown>, ctx: AgentToolCtx): Promise<ToolResult> {
  const name = str(args, "name").trim() || `note-${Date.now()}.md`;
  const content = str(args, "content");
  if (!content.trim()) return { content: "Nothing to write — content was empty." };
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "md";
  const mime = WRITE_EXT[ext] ?? "text/plain";
  const id = uuid();
  const relPath = `drive/${id}.${ext || "txt"}`;
  try {
    // Atomic blob write (.part then rename) under DATA_DIR, mirroring the
    // upload path in routes/drive.ts.
    const absPath = join(DATA_DIR, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(`${absPath}.part`, content, "utf8");
    await rename(`${absPath}.part`, absPath);
    const bytes = Buffer.byteLength(content, "utf8");
    run(
      `INSERT INTO drive_files (id, user_id, name, mime, size_bytes, rel_path, origin, index_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'generated', 'pending', ?, ?)`,
      id,
      ctx.userId,
      name,
      mime,
      bytes,
      relPath,
      nowISO(),
      nowISO(),
    );
    return { content: `Wrote "${name}" to Drive (file_id=${id}).` };
  } catch (err) {
    return { content: `Failed to write to Drive: ${(err as Error).message}` };
  }
}

export const driveWriteTool: AgentTool = {
  name: "drive_write",
  description: "Save a text/markdown file into the user's Drive so it persists and can be indexed. Returns the new file_id.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Filename with extension, e.g. summary.md." },
      content: { type: "string" },
    },
    required: ["name", "content"],
    additionalProperties: false,
  },
  kind: "write_internal",
  label: (args) => `Writing "${str(args, "name") || "note"}" to Drive`,
  execute: driveWrite,
};

// ─── hub_memory_search ──────────────────────────────────────────────

async function hubMemorySearch(args: Record<string, unknown>, ctx: AgentToolCtx): Promise<ToolResult> {
  const query = str(args, "query");
  if (!query.trim()) return { content: "Provide a query." };
  const hubId = str(args, "hub_id") || ctx.hubId || "";
  if (!hubId) {
    return { content: "No hub is attached to this run and no hub_id was given, so there is no hub memory to search." };
  }
  const embedding = await embedText(query);
  if (!embedding) return { content: "Embedding is unavailable, so hub memory cannot be searched right now." };
  const hits = searchHubMemory(hubId, embedding, 8);
  if (hits.length === 0) return { content: `No relevant hub memory found for "${query}".` };
  const blocks = hits.map(
    (h, i) => `[${i + 1}] ${h.cite_label}${h.file_name ? ` — ${h.file_name}` : ""} (score ${h.score.toFixed(2)}):\n${sanitize(h.chunk_text).slice(0, 600)}`,
  );
  return { content: `Hub memory results for "${query}":\n\n${blocks.join("\n\n")}` };
}

export const hubMemorySearchTool: AgentTool = {
  name: "hub_memory_search",
  description:
    "Semantic search over the attached hub's indexed files and notes. Use it to ground answers in the user's own documents.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      hub_id: { type: "string", description: "Optional — defaults to the run's hub." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  kind: "read",
  label: (args) => `Searching hub memory for "${str(args, "query").slice(0, 60)}"`,
  execute: hubMemorySearch,
};

// ─── get_datetime ───────────────────────────────────────────────────

async function getDatetime(args: Record<string, unknown>): Promise<ToolResult> {
  const tz = str(args, "timezone").trim();
  const now = new Date();
  const iso = now.toISOString();
  let local: string;
  let dayName: string;
  if (tz) {
    try {
      local = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        dateStyle: "full",
        timeStyle: "long",
      }).format(now);
      dayName = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now);
    } catch {
      return {
        content: `Unknown timezone "${tz}". Use an IANA name like "America/New_York" or "Asia/Kolkata".`,
      };
    }
  } else {
    local = now.toString();
    dayName = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(now);
  }
  const lines = [
    `Day of week: ${dayName}`,
    `Local time${tz ? ` (${tz})` : ""}: ${local}`,
    `ISO 8601 (UTC): ${iso}`,
    `Unix epoch (seconds): ${Math.floor(now.getTime() / 1000)}`,
  ];
  return { content: lines.join("\n") };
}

export const getDatetimeTool: AgentTool = {
  name: "get_datetime",
  description:
    "Get the current date and time — day of week, local time (optionally in a given IANA timezone), the UTC ISO 8601 string, and the Unix epoch. No network access.",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: 'Optional IANA timezone, e.g. "Europe/London" or "America/New_York".',
      },
    },
    additionalProperties: false,
  },
  kind: "read",
  label: (args) =>
    str(args, "timezone") ? `Getting the time in ${str(args, "timezone")}` : "Getting the current date and time",
  execute: getDatetime,
};

// ─── calculator (safe expression evaluator) ─────────────────────────

// A tiny recursive-descent arithmetic evaluator. No eval / new Function — the
// input is tokenized then parsed against a fixed grammar with a whitelist of
// functions and constants, so nothing but arithmetic can run.

type CalcTok =
  | { t: "num"; v: number }
  | { t: "op"; v: string }
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "comma" }
  | { t: "ident"; v: string };

const CALC_FUNCS: Record<string, (a: number[]) => number> = {
  sqrt: (a) => Math.sqrt(a[0]),
  abs: (a) => Math.abs(a[0]),
  round: (a) => Math.round(a[0]),
  floor: (a) => Math.floor(a[0]),
  ceil: (a) => Math.ceil(a[0]),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  pow: (a) => a[0] ** a[1],
  log: (a) => Math.log10(a[0]), // base-10
  ln: (a) => Math.log(a[0]), // natural
  sin: (a) => Math.sin(a[0]),
  cos: (a) => Math.cos(a[0]),
  tan: (a) => Math.tan(a[0]),
};

const CALC_CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

function calcTokenize(input: string): CalcTok[] {
  const toks: CalcTok[] = [];
  const s = input;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && s[i + 1] >= "0" && s[i + 1] <= "9")) {
      let j = i;
      while (j < s.length && ((s[j] >= "0" && s[j] <= "9") || s[j] === ".")) j++;
      if (s[j] === "e" || s[j] === "E") {
        let k = j + 1;
        if (s[k] === "+" || s[k] === "-") k++;
        if (s[k] >= "0" && s[k] <= "9") {
          j = k;
          while (j < s.length && s[j] >= "0" && s[j] <= "9") j++;
        }
      }
      const numStr = s.slice(i, j);
      const v = Number(numStr);
      if (!Number.isFinite(v)) throw new Error(`invalid number "${numStr}"`);
      toks.push({ t: "num", v });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
      toks.push({ t: "ident", v: s.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if (c === "*" && s[i + 1] === "*") {
      toks.push({ t: "op", v: "**" });
      i += 2;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "%") {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "(") {
      toks.push({ t: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ t: "rparen" });
      i++;
      continue;
    }
    if (c === ",") {
      toks.push({ t: "comma" });
      i++;
      continue;
    }
    throw new Error(`unexpected character "${c}"`);
  }
  return toks;
}

function calcCheckArity(name: string, args: number[]): void {
  if (name === "min" || name === "max") {
    if (args.length < 1) throw new Error(`${name}() needs at least one argument`);
    return;
  }
  const arity = name === "pow" ? 2 : 1;
  if (args.length !== arity) {
    throw new Error(`${name}() takes ${arity} argument(s) but got ${args.length}`);
  }
}

class CalcParser {
  private pos = 0;
  constructor(private readonly toks: CalcTok[]) {}

  parse(): number {
    const v = this.expr();
    if (this.pos < this.toks.length) throw new Error("unexpected trailing input");
    return v;
  }

  private peek(): CalcTok | undefined {
    return this.toks[this.pos];
  }

  private expect(type: CalcTok["t"]): void {
    if (this.peek()?.t !== type) throw new Error(`expected ${type}`);
    this.pos++;
  }

  private expr(): number {
    return this.additive();
  }

  private additive(): number {
    let left = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (t?.t === "op" && (t.v === "+" || t.v === "-")) {
        this.pos++;
        const right = this.multiplicative();
        left = t.v === "+" ? left + right : left - right;
      } else break;
    }
    return left;
  }

  private multiplicative(): number {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t?.t === "op" && (t.v === "*" || t.v === "/" || t.v === "%")) {
        this.pos++;
        const right = this.unary();
        left = t.v === "*" ? left * right : t.v === "/" ? left / right : left % right;
      } else break;
    }
    return left;
  }

  private unary(): number {
    const t = this.peek();
    if (t?.t === "op" && (t.v === "+" || t.v === "-")) {
      this.pos++;
      const v = this.unary();
      return t.v === "-" ? -v : v;
    }
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    const t = this.peek();
    if (t?.t === "op" && t.v === "**") {
      this.pos++;
      // right-associative; the exponent may itself be signed (2**-2)
      return base ** this.unary();
    }
    return base;
  }

  private primary(): number {
    const t = this.peek();
    if (!t) throw new Error("unexpected end of expression");
    if (t.t === "num") {
      this.pos++;
      return t.v;
    }
    if (t.t === "lparen") {
      this.pos++;
      const v = this.expr();
      this.expect("rparen");
      return v;
    }
    if (t.t === "ident") {
      this.pos++;
      const name = t.v;
      if (this.peek()?.t === "lparen") {
        this.pos++;
        const args: number[] = [];
        if (this.peek()?.t !== "rparen") {
          args.push(this.expr());
          while (this.peek()?.t === "comma") {
            this.pos++;
            args.push(this.expr());
          }
        }
        this.expect("rparen");
        const fn = CALC_FUNCS[name];
        if (!fn) throw new Error(`unknown function "${name}"`);
        calcCheckArity(name, args);
        return fn(args);
      }
      if (name in CALC_CONSTS) return CALC_CONSTS[name];
      throw new Error(`unknown identifier "${name}"`);
    }
    throw new Error("unexpected token");
  }
}

/** Safely evaluate an arithmetic expression. Throws on any malformed input. */
export function evalExpression(expr: string): number {
  const toks = calcTokenize(expr);
  if (toks.length === 0) throw new Error("empty expression");
  const result = new CalcParser(toks).parse();
  if (!Number.isFinite(result)) throw new Error("result is not a finite number");
  return result;
}

async function calculator(args: Record<string, unknown>): Promise<ToolResult> {
  const expr = str(args, "expression").trim();
  if (!expr) return { content: "Provide an arithmetic expression to evaluate." };
  try {
    return { content: `${expr} = ${fmtNum(evalExpression(expr))}` };
  } catch (err) {
    return { content: `Could not evaluate "${expr}": ${(err as Error).message}` };
  }
}

export const calculatorTool: AgentTool = {
  name: "calculator",
  description:
    "Evaluate an arithmetic expression. Supports + - * / % ** (power), parentheses, unary minus, the functions sqrt, abs, round, floor, ceil, min, max, pow, log (base 10), ln (natural), sin, cos, tan, and the constants pi and e. No network access.",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: 'e.g. "(2 + 3) * sqrt(16) / 2 ** 2".' },
    },
    required: ["expression"],
    additionalProperties: false,
  },
  kind: "read",
  label: (args) => `Calculating ${str(args, "expression").slice(0, 60)}`,
  execute: calculator,
};

// ─── unit_convert ───────────────────────────────────────────────────

// Each dimension maps its units to a factor relative to a base unit. A value
// in unit U equals value*factor[U] base units; converting is value*from/to.
// Temperature is affine and handled separately.
const UNIT_DIMENSIONS: Record<string, Record<string, number>> = {
  length: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 },
  mass: { mg: 0.001, g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237, st: 6350.29318, t: 1_000_000 },
  volume: {
    ml: 0.001,
    l: 1,
    tsp: 0.00492892159375,
    tbsp: 0.01478676478125,
    cup: 0.2365882365,
    pt: 0.473176473,
    qt: 0.946352946,
    gal: 3.785411784,
  },
  data: { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 },
  time: { s: 1, min: 60, h: 3600, day: 86_400, week: 604_800 },
};

const TEMP_UNITS = new Set(["c", "f", "k"]);

function tempToKelvin(v: number, unit: string): number {
  if (unit === "c") return v + 273.15;
  if (unit === "f") return ((v - 32) * 5) / 9 + 273.15;
  return v; // k
}

function kelvinToTemp(k: number, unit: string): number {
  if (unit === "c") return k - 273.15;
  if (unit === "f") return ((k - 273.15) * 9) / 5 + 32;
  return k; // k
}

function unitDimension(unit: string): string | null {
  for (const [dim, table] of Object.entries(UNIT_DIMENSIONS)) {
    if (unit in table) return dim;
  }
  return null;
}

/** Convert `value` from one unit to another within the same dimension. */
export function convertUnit(value: number, from: string, to: string): number {
  if (!Number.isFinite(value)) throw new Error("value must be a finite number");
  const f = from.trim().toLowerCase();
  const t = to.trim().toLowerCase();
  if (TEMP_UNITS.has(f) || TEMP_UNITS.has(t)) {
    if (!TEMP_UNITS.has(f) || !TEMP_UNITS.has(t)) {
      throw new Error(`cannot convert between "${from}" and "${to}" (dimension mismatch)`);
    }
    return kelvinToTemp(tempToKelvin(value, f), t);
  }
  const fromDim = unitDimension(f);
  const toDim = unitDimension(t);
  if (!fromDim) throw new Error(`unknown unit "${from}"`);
  if (!toDim) throw new Error(`unknown unit "${to}"`);
  if (fromDim !== toDim) throw new Error(`cannot convert ${fromDim} to ${toDim} (dimension mismatch)`);
  const table = UNIT_DIMENSIONS[fromDim];
  return (value * table[f]) / table[t];
}

async function unitConvert(args: Record<string, unknown>): Promise<ToolResult> {
  const value = num(args, "value");
  const from = str(args, "from").trim();
  const to = str(args, "to").trim();
  if (!Number.isFinite(value)) return { content: "Provide a numeric value." };
  if (!from || !to) return { content: "Provide both a from unit and a to unit." };
  try {
    const result = convertUnit(value, from, to);
    return { content: `${fmtNum(value)} ${from} = ${fmtNum(result)} ${to}` };
  } catch (err) {
    return { content: `Could not convert: ${(err as Error).message}` };
  }
}

export const unitConvertTool: AgentTool = {
  name: "unit_convert",
  description:
    "Convert a value between units of the same dimension. Supported: length (mm,cm,m,km,in,ft,yd,mi), mass (mg,g,kg,oz,lb,st,t), temperature (c,f,k), volume (ml,l,tsp,tbsp,cup,pt,qt,gal), data (b,kb,mb,gb,tb — binary/1024-based bytes), time (s,min,h,day,week). No network access.",
  parameters: {
    type: "object",
    properties: {
      value: { type: "number" },
      from: { type: "string", description: "Source unit, e.g. km." },
      to: { type: "string", description: "Target unit, e.g. mi." },
    },
    required: ["value", "from", "to"],
    additionalProperties: false,
  },
  kind: "read",
  label: (args) => `Converting ${fmtNum(num(args, "value"))} ${str(args, "from")} to ${str(args, "to")}`,
  execute: unitConvert,
};

// ─── currency_convert ───────────────────────────────────────────────

async function currencyConvert(args: Record<string, unknown>, ctx: AgentToolCtx): Promise<ToolResult> {
  const amount = num(args, "amount");
  const from = str(args, "from").trim().toUpperCase();
  const to = str(args, "to").trim().toUpperCase();
  if (!Number.isFinite(amount)) return { content: "Provide a numeric amount." };
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    return { content: "Provide 3-letter ISO currency codes, e.g. USD, EUR, GBP." };
  }
  if (from === to) return { content: `${fmtNum(amount)} ${from} = ${fmtNum(amount)} ${to} (rate 1).` };
  try {
    const res = await guardedFetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`, ctx);
    if (!res.ok) {
      return { content: `Currency service returned HTTP ${res.status}. Check that both codes are valid.` };
    }
    const data = (await res.json()) as { rates?: Record<string, number>; date?: string };
    const rate = data.rates?.[to];
    if (typeof rate !== "number") {
      return { content: `No exchange rate available for ${from} → ${to}.` };
    }
    const converted = amount * rate;
    return {
      content: `${fmtNum(amount)} ${from} = ${fmtNum(converted)} ${to}\nRate: 1 ${from} = ${rate} ${to} (ECB reference rate, ${data.date ?? "latest"}).`,
    };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return { content: `Currency conversion is unavailable right now (${(err as Error).message}).` };
  }
}

export const currencyConvertTool: AgentTool = {
  name: "currency_convert",
  description:
    "Convert an amount between currencies using live European Central Bank reference rates (no API key). Give 3-letter ISO codes like USD, EUR, JPY.",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number" },
      from: { type: "string", description: "3-letter source currency code, e.g. USD." },
      to: { type: "string", description: "3-letter target currency code, e.g. EUR." },
    },
    required: ["amount", "from", "to"],
    additionalProperties: false,
  },
  kind: "read",
  label: (args) =>
    `Converting ${fmtNum(num(args, "amount"))} ${str(args, "from").toUpperCase()} to ${str(args, "to").toUpperCase()}`,
  execute: currencyConvert,
};

// ─── wikipedia_lookup ───────────────────────────────────────────────

interface WikiSummary {
  title: string;
  extract: string;
  url: string;
}

async function wikiSummary(title: string, ctx: AgentToolCtx): Promise<WikiSummary | null> {
  const slug = encodeURIComponent(title.replace(/ /g, "_"));
  const res = await guardedFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`, ctx);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    title?: string;
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
  };
  if (!data.extract) return null;
  return {
    title: data.title ?? title,
    extract: data.extract,
    url: data.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${slug}`,
  };
}

async function wikiSearchTitle(query: string, ctx: AgentToolCtx): Promise<string | null> {
  const res = await guardedFetch(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`,
    ctx,
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { query?: { search?: Array<{ title?: string }> } };
  return data.query?.search?.[0]?.title ?? null;
}

async function wikipediaLookup(args: Record<string, unknown>, ctx: AgentToolCtx): Promise<ToolResult> {
  const query = str(args, "query").trim();
  if (!query) return { content: "Provide a search query." };
  try {
    let summary = await wikiSummary(query, ctx);
    if (!summary) {
      const title = await wikiSearchTitle(query, ctx);
      if (title) summary = await wikiSummary(title, ctx);
    }
    if (!summary) return { content: `No Wikipedia article found for "${query}".` };
    const extract = sanitize(summary.extract).slice(0, 2000);
    return { content: `${summary.title}\n${summary.url}\n\n${extract}` };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return { content: `Wikipedia lookup is unavailable right now (${(err as Error).message}).` };
  }
}

export const wikipediaLookupTool: AgentTool = {
  name: "wikipedia_lookup",
  description:
    "Look up a topic on English Wikipedia and return the article summary plus its URL (no API key). Falls back to Wikipedia search when there is no exact page title match.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "A topic or article title." } },
    required: ["query"],
    additionalProperties: false,
  },
  kind: "read",
  maxResultChars: 3000,
  label: (args) => `Looking up "${str(args, "query").slice(0, 60)}" on Wikipedia`,
  execute: wikipediaLookup,
};

// ─── weather ────────────────────────────────────────────────────────

// WMO weather interpretation codes (Open-Meteo).
const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snowfall",
  73: "Moderate snowfall",
  75: "Heavy snowfall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

function weatherDesc(code: number | undefined): string {
  return code == null ? "Unknown" : (WEATHER_CODES[code] ?? `Weather code ${code}`);
}

async function weather(args: Record<string, unknown>, ctx: AgentToolCtx): Promise<ToolResult> {
  const location = str(args, "location").trim();
  if (!location) return { content: "Provide a location, e.g. a city name." };
  try {
    const geoRes = await guardedFetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
      ctx,
    );
    if (!geoRes.ok) return { content: `Weather geocoding failed (HTTP ${geoRes.status}).` };
    const geo = (await geoRes.json()) as {
      results?: Array<{ latitude: number; longitude: number; name: string; country?: string; admin1?: string }>;
    };
    const place = geo.results?.[0];
    if (!place) return { content: `Could not find a location named "${location}".` };

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
      `&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=3&timezone=auto`;
    const wRes = await guardedFetch(url, ctx);
    if (!wRes.ok) return { content: `Weather service failed (HTTP ${wRes.status}).` };
    const w = (await wRes.json()) as {
      current?: {
        temperature_2m?: number;
        relative_humidity_2m?: number;
        weather_code?: number;
        wind_speed_10m?: number;
      };
      current_units?: Record<string, string>;
      daily?: {
        time?: string[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        weather_code?: number[];
      };
    };

    const placeLabel = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
    const tUnit = w.current_units?.temperature_2m ?? "°C";
    const wUnit = w.current_units?.wind_speed_10m ?? "km/h";
    const lines = [`Weather for ${placeLabel}:`];
    const cur = w.current;
    if (cur) {
      lines.push(
        `Now: ${weatherDesc(cur.weather_code)}, ${cur.temperature_2m}${tUnit}, ` +
          `humidity ${cur.relative_humidity_2m}%, wind ${cur.wind_speed_10m}${wUnit}`,
      );
    }
    const d = w.daily;
    if (d?.time?.length) {
      lines.push("3-day forecast:");
      for (let i = 0; i < d.time.length; i++) {
        lines.push(
          `  ${d.time[i]}: ${weatherDesc(d.weather_code?.[i])}, ` +
            `${d.temperature_2m_min?.[i]}–${d.temperature_2m_max?.[i]}${tUnit}`,
        );
      }
    }
    return { content: lines.join("\n") };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return { content: `Weather is unavailable right now (${(err as Error).message}).` };
  }
}

export const weatherTool: AgentTool = {
  name: "weather",
  description:
    "Get current conditions and a 3-day forecast for a location using Open-Meteo (no API key). Geocodes the location name first, then reports temperature, humidity, wind, and daily highs/lows.",
  parameters: {
    type: "object",
    properties: { location: { type: "string", description: "A city or place name, e.g. Tokyo." } },
    required: ["location"],
    additionalProperties: false,
  },
  kind: "read",
  label: (args) => `Getting the weather for ${str(args, "location").slice(0, 60)}`,
  execute: weather,
};

// ─── http_get_json (SSRF-guarded public API GET) ────────────────────

const HTTP_JSON_OUTPUT_CAP = 12_000;
const HTTP_JSON_MAX_BYTES = 512 * 1024; // read cap so a huge body can't be slurped

// Reject private/loopback/link-local/internal hosts. `hostname` may be a DNS
// name, an IPv4 literal, or an IPv6 literal (with or without brackets).
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h.includes(":")) {
    // IPv6 literal: loopback ::1, unspecified ::, link-local fe80::/10,
    // unique-local fc00::/7 (fc.. / fd..).
    if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1") return true;
    if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
    return false;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const o = m.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) return true; // malformed octet -> reject
    const [a, b] = o;
    if (a === 0 || a === 127 || a === 10) return true; // this-network, loopback, 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 169 && b === 254) return true; // 169.254/16 link-local
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  return false; // ordinary public DNS hostname
}

/** Validate a URL for http_get_json: scheme, host allow-list, and — to defeat
 *  DNS-rebinding to an internal IP — resolve the name and re-check every
 *  address it points to. Throws with a human-readable reason on rejection. */
async function assertSafeUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("only http and https URLs are allowed");
  }
  if (isBlockedHost(u.hostname)) {
    throw new Error("that host is not allowed (private, loopback, or internal address)");
  }
  const host = u.hostname.replace(/^\[/, "").replace(/\]$/, "");
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`could not resolve host "${host}"`);
  }
  for (const a of addrs) {
    if (isBlockedHost(a.address)) throw new Error("that host resolves to a private/loopback address");
  }
  return u;
}

async function readCappedText(res: Response, maxBytes: number): Promise<{ text: string; capped: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: await res.text(), capped: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total > maxBytes) {
        capped = true;
        await reader.cancel();
        break;
      }
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), capped };
}

async function httpGetJson(args: Record<string, unknown>, ctx: AgentToolCtx): Promise<ToolResult> {
  const url = str(args, "url").trim();
  if (!url) return { content: "Provide a URL." };
  let safe: URL;
  try {
    safe = await assertSafeUrl(url);
  } catch (err) {
    return { content: `Blocked: ${(err as Error).message}.` };
  }
  try {
    const res = await guardedFetch(safe.toString(), ctx, 15_000, { headers: { Accept: "application/json" } });
    const ctype = res.headers.get("content-type") ?? "";
    if (!res.ok) return { content: `${safe.hostname} returned HTTP ${res.status}.` };
    const { text: body, capped } = await readCappedText(res, HTTP_JSON_MAX_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      if (capped) return { content: "The response was too large to parse as JSON." };
      return { content: `The response was not valid JSON (content-type: ${ctype || "unknown"}).` };
    }
    let pretty = JSON.stringify(parsed, null, 2);
    let truncated = false;
    if (pretty.length > HTTP_JSON_OUTPUT_CAP) {
      pretty = pretty.slice(0, HTTP_JSON_OUTPUT_CAP);
      truncated = true;
    }
    return { content: `GET ${safe.toString()}\n\n${pretty}${truncated ? "\n\n[truncated]" : ""}` };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return { content: `Request failed: ${(err as Error).message}.` };
  }
}

export const httpGetJsonTool: AgentTool = {
  name: "http_get_json",
  description:
    "GET a public http(s) URL that returns JSON and return the parsed, pretty-printed body — a general way to call a public REST API. Only public hosts are allowed (private, loopback, and internal addresses are refused).",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "A public http(s) URL returning JSON." } },
    required: ["url"],
    additionalProperties: false,
  },
  kind: "read",
  maxResultChars: 13_000,
  label: (args) => `GET ${str(args, "url").slice(0, 80)}`,
  execute: httpGetJson,
};

export const BUILTIN_TOOLS: AgentTool[] = [
  updatePlanTool,
  webSearchTool,
  fetchUrlTool,
  youtubeTranscriptTool,
  driveListTool,
  driveReadTool,
  driveWriteTool,
  hubMemorySearchTool,
  askUserTool,
  getDatetimeTool,
  calculatorTool,
  unitConvertTool,
  currencyConvertTool,
  wikipediaLookupTool,
  weatherTool,
  httpGetJsonTool,
];
