// Hand-written agent tools. update_plan and ask_user carry a schema/label
// but no execute() — the orchestrator intercepts them by name (update_plan
// rewrites the run's plan; ask_user suspends for a question card). The rest
// execute normally.
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
];
