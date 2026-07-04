// Sheet generator: prompt (+ optional hub memory grounding) -> column
// schema via callLLMJSON -> ONE streaming completion that emits NDJSON
// rows (one JSON array per line), parsed line-by-line as chunks arrive so
// the UI fills in row-by-row -> artifact row (kind 'sheet', no blob).
//
// Content shape stored in artifacts.content:
//   { columns: [{name, type: 'text'|'number'|'date'|'url'}], rows: cell[][] }
// rows is an array of cell arrays aligned to `columns`; number-typed cells
// are stored as JS numbers where they parse. No formulas in v1 — every
// value is LLM-computed. revise() is a full-replacement callLLMJSON pass
// that yields a NEW artifact with parent_id lineage.
import { z } from "zod";
import {
  LLM_REQUEST_OPTS,
  MODELS,
  callLLMJSON,
  embedText,
  fromJson,
  openai,
  providerRoutingForCache,
  wrapSystemForCache,
} from "@omni/sdk";
import { searchHubMemory } from "../lib/hub-memory.js";
import { titleFromPrompt } from "./doc.js";
import {
  getArtifact,
  insertArtifact,
  toArtifactSummary,
  type ArtifactSummary,
  type GenCtx,
  type GeneratorService,
} from "./types.js";

// ─── Input ──────────────────────────────────────────────────────────

const SheetInputSchema = z.object({
  prompt: z.string().min(1).max(4000),
  hub_id: z.string().nullable().optional(),
  columns_hint: z.string().max(500).optional(),
  rows_hint: z.number().int().min(3).max(200).default(12),
  // Override mainly for tests; sheets default to the cheap model.
  model: z.string().optional(),
});

export type SheetInput = z.infer<typeof SheetInputSchema>;

// ─── Content types ──────────────────────────────────────────────────

export const SHEET_COLUMN_TYPES = ["text", "number", "date", "url"] as const;
export type SheetColumnType = (typeof SHEET_COLUMN_TYPES)[number];

export interface SheetColumn {
  name: string;
  type: SheetColumnType;
}

export type SheetCell = string | number | null;

export interface SheetContent {
  columns: SheetColumn[];
  rows: SheetCell[][];
}

const MAX_COLUMNS = 16;

// ─── Pure helpers (exported for tests) ──────────────────────────────

/**
 * Coerce one raw cell value to its stored shape. Number columns parse
 * numeric strings (tolerating "$1,200", "45%", " 3.5 ") into JS numbers;
 * unparseable values stay strings so the grid still shows something.
 * Empty strings and null/undefined normalize to null.
 */
export function coerceCell(value: unknown, type: SheetColumnType): SheetCell {
  if (value === null || value === undefined) return null;
  if (type === "number") {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      const cleaned = value
        .trim()
        .replace(/^[$€£]\s*/, "")
        .replace(/%$/, "")
        .replace(/,/g, "");
      if (cleaned !== "" && Number.isFinite(Number(cleaned))) return Number(cleaned);
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    }
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

/**
 * Parse one NDJSON line into a row of cells, or null when the line is
 * malformed (not JSON, not a flat array, a nested batch, prose, a code
 * fence...). Wrong-length arrays are tolerated: extras are dropped and
 * missing cells padded with null so rows stay aligned to the columns.
 * A trailing comma is stripped so a pretty-printed JSON array-of-arrays
 * (one row per line) degrades gracefully into valid rows.
 */
export function parseRowLine(line: string, columns: SheetColumn[]): SheetCell[] | null {
  const trimmed = line.trim().replace(/,\s*$/, "");
  if (!trimmed.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed.some((v) => Array.isArray(v))) return null; // nested batch line
  const cells = parsed
    .slice(0, columns.length)
    .map((v, i) => coerceCell(v, columns[i].type));
  while (cells.length < columns.length) cells.push(null);
  return cells;
}

export interface NdjsonRowParser {
  /** Feed a stream chunk; returns the rows completed by this chunk. */
  push(chunk: string): SheetCell[][];
  /** Drain the buffered final line (streams rarely end with \n). */
  flush(): SheetCell[][];
}

/** Stateful line buffer over stream chunks: splits on \n, keeps partial
 *  lines buffered, silently skips lines parseRowLine rejects. */
export function createNdjsonRowParser(columns: SheetColumn[]): NdjsonRowParser {
  let buf = "";
  return {
    push(chunk: string): SheetCell[][] {
      buf += chunk;
      const rows: SheetCell[][] = [];
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const row = parseRowLine(line, columns);
        if (row) rows.push(row);
      }
      return rows;
    },
    flush(): SheetCell[][] {
      const line = buf;
      buf = "";
      const row = parseRowLine(line, columns);
      return row ? [row] : [];
    },
  };
}

/** Sanitize model-drafted columns: named, typed, deduped, capped. */
export function normalizeColumns(raw: unknown): SheetColumn[] {
  if (!Array.isArray(raw)) return [];
  const cols: SheetColumn[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const name = String((entry as { name?: unknown }).name ?? "")
      .trim()
      .slice(0, 80);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const t = String((entry as { type?: unknown }).type ?? "").toLowerCase();
    const type = (SHEET_COLUMN_TYPES as readonly string[]).includes(t)
      ? (t as SheetColumnType)
      : "text";
    cols.push({ name, type });
    if (cols.length >= MAX_COLUMNS) break;
  }
  return cols;
}

/** Sanitize a full row matrix (revise path): keeps arrays only, aligns
 *  every row to the column count, coerces cells by column type. */
export function normalizeRows(raw: unknown, columns: SheetColumn[]): SheetCell[][] {
  if (!Array.isArray(raw)) return [];
  const rows: SheetCell[][] = [];
  for (const r of raw) {
    if (!Array.isArray(r)) continue;
    const cells = r.slice(0, columns.length).map((v, i) => coerceCell(v, columns[i].type));
    while (cells.length < columns.length) cells.push(null);
    rows.push(cells);
  }
  return rows;
}

/**
 * Serialize {columns, rows} for the revise prompt, halving the row count
 * until the JSON fits the byte budget (~30KB default). Reports how many
 * rows made it in so the prompt can note the truncation.
 */
export function serializeSheetForPrompt(
  content: SheetContent,
  budget = 30_000,
): { json: string; shownRows: number; truncated: boolean } {
  let rows = content.rows;
  let json = JSON.stringify({ columns: content.columns, rows });
  while (json.length > budget && rows.length > 1) {
    rows = rows.slice(0, Math.ceil(rows.length / 2));
    json = JSON.stringify({ columns: content.columns, rows });
  }
  return {
    json,
    shownRows: rows.length,
    truncated: rows.length < content.rows.length,
  };
}

// ─── Hub grounding (mirrors slides.ts) ──────────────────────────────

async function buildGrounding(
  hubId: string,
  prompt: string,
  ctx: GenCtx,
): Promise<string | undefined> {
  ctx.emit({ type: "status", label: "Searching hub memory" });
  const embedding = await embedText(prompt);
  if (!embedding) return undefined;
  const hits = searchHubMemory(hubId, embedding, 10);
  if (hits.length === 0) return undefined;
  let budget = 9_000;
  const parts: string[] = ["Reference material from the user's hub:"];
  for (const h of hits) {
    const entry = `[${h.cite_label}] ${h.chunk_text.slice(0, 1000)}`;
    if (entry.length > budget) break;
    budget -= entry.length;
    parts.push(entry);
  }
  return parts.join("\n\n");
}

// ─── Streaming plumbing (same loose binding as doc.ts) ──────────────

// Structural stream-chunk shape (OpenRouter's OpenAI-compatible SSE chunks).
interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

type OaiMessage = { role: "system" | "user" | "assistant"; content: unknown };

// The OpenAI SDK's create() overloads fight structural message arrays under
// strict TS; bind a loosely-typed alias once and keep the loosening local.
const createChatStream = openai.chat.completions.create.bind(
  openai.chat.completions,
) as unknown as (
  body: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<AsyncIterable<StreamChunk>>;

// ─── Prompt assembly ────────────────────────────────────────────────

function schemaSystem(): string {
  return [
    "You design spreadsheet schemas. Given a request, pick the single most useful set of columns.",
    'Output JSON: {"title": string, "columns": [{"name": string, "type": "text"|"number"|"date"|"url"}]}.',
    "Rules:",
    "- 2-10 focused columns; short Title Case names; no duplicate columns.",
    '- "number" for quantities/prices/counts, "date" for calendar dates, "url" for links, "text" otherwise.',
    "- title: a short human name for the sheet (max 8 words).",
  ].join("\n");
}

function rowsSystem(columns: SheetColumn[], rowCount: number): string {
  const columnList = columns
    .map((c, i) => `  ${i + 1}. ${JSON.stringify(c.name)} (${c.type})`)
    .join("\n");
  return [
    "You fill spreadsheets with accurate, useful data.",
    "Output ONLY NDJSON: one JSON array per line, nothing else. Each line is one row:",
    `a flat JSON array with exactly ${columns.length} values, in this exact column order:`,
    columnList,
    "Rules:",
    `- Output exactly ${rowCount} lines (${rowCount} rows), one JSON array per line.`,
    "- number columns: bare JSON numbers — no quotes, units, or thousands separators.",
    '- date columns: "YYYY-MM-DD" strings.',
    '- url columns: full "https://..." URLs.',
    "- text columns: concise strings.",
    '- Use null when a value is genuinely unknown; never invent placeholders like "N/A".',
    "- No markdown, no code fences, no header row, no commentary, no blank lines.",
  ].join("\n");
}

/** Stream the rows completion, emitting a row delta per parsed line. */
async function streamRows(opts: {
  columns: SheetColumn[];
  rowCap: number;
  prompt: string;
  grounding?: string;
  model: string;
  ctx: GenCtx;
}): Promise<SheetCell[][]> {
  const { columns, rowCap, model, ctx } = opts;
  const system = rowsSystem(columns, rowCap);
  const messages: OaiMessage[] = [
    { role: "system", content: wrapSystemForCache(system, model) },
  ];
  if (opts.grounding) messages.push({ role: "system", content: opts.grounding });
  messages.push({ role: "user", content: opts.prompt });

  ctx.emit({ type: "status", label: "Filling rows" });
  const stream = await createChatStream(
    {
      model,
      messages,
      stream: true,
      // ~80 output tokens covers a generously wide row; headroom is cheap
      // (short outputs cost the same) and avoids truncating the last rows.
      max_tokens: Math.min(16_000, 600 + rowCap * 80),
      // Structured output: a reasoning model would burn the budget thinking.
      reasoning: { enabled: false },
      ...providerRoutingForCache(model),
    },
    { ...LLM_REQUEST_OPTS, signal: ctx.signal },
  );

  const parser = createNdjsonRowParser(columns);
  const rows: SheetCell[][] = [];
  const takeRow = (row: SheetCell[]): boolean => {
    rows.push(row);
    ctx.emit({ type: "delta", channel: "row", data: row });
    return rows.length >= rowCap;
  };

  let capped = false;
  for await (const chunk of stream) {
    if (ctx.signal.aborted) throw new Error("aborted");
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta !== "string" || delta.length === 0) continue;
    for (const row of parser.push(delta)) {
      if (takeRow(row)) {
        capped = true;
        break;
      }
    }
    // Breaking out of for-await closes the iterator, aborting the request.
    if (capped) break;
  }
  if (!capped) {
    for (const row of parser.flush()) {
      if (takeRow(row)) break;
    }
  }
  if (rows.length === 0) throw new Error("Model produced no rows");
  return rows;
}

// ─── run() ──────────────────────────────────────────────────────────

async function runSheet(input: SheetInput, ctx: GenCtx): Promise<ArtifactSummary> {
  const model = input.model ?? MODELS.cheap;

  const grounding = input.hub_id
    ? await buildGrounding(input.hub_id, input.prompt, ctx)
    : undefined;
  if (ctx.signal.aborted) throw new Error("aborted");

  // ── Pass 1: schema ── (callLLMJSON takes no signal; check around it)
  ctx.emit({ type: "status", label: "Designing columns" });
  const draft = await callLLMJSON<{ title?: unknown; columns?: unknown }>({
    system: schemaSystem(),
    cachedContext: grounding,
    prompt: [
      `Spreadsheet request: ${input.prompt}`,
      input.columns_hint ? `Column guidance from the user: ${input.columns_hint}` : "",
      grounding
        ? "Ground your column choices in the reference material above where relevant."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    model,
    maxTokens: 800,
  });
  if (ctx.signal.aborted) throw new Error("aborted");

  const columns = normalizeColumns(draft?.columns);
  if (columns.length === 0) throw new Error("Model returned no usable columns");
  const title =
    (typeof draft?.title === "string" && draft.title.trim().slice(0, 120)) ||
    titleFromPrompt(input.prompt);

  ctx.emit({ type: "delta", channel: "schema", data: { title, columns } });

  // ── Pass 2: rows, streamed as NDJSON ──
  const rows = await streamRows({
    columns,
    rowCap: input.rows_hint,
    prompt: [
      `Fill the sheet "${title}" for this request: ${input.prompt}`,
      grounding ? "Ground the data in the reference material above where relevant." : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    grounding,
    model,
    ctx,
  });

  const content: SheetContent = { columns, rows };
  const row = insertArtifact({
    userId: ctx.userId,
    kind: "sheet",
    title,
    content,
    hubId: input.hub_id ?? null,
    meta: { prompt: input.prompt, model, rows: rows.length, columns: columns.length },
  });
  return toArtifactSummary(row);
}

// ─── revise() ───────────────────────────────────────────────────────

async function reviseSheet(
  artifactId: string,
  instruction: string,
  ctx: GenCtx,
): Promise<ArtifactSummary> {
  const parent = getArtifact(artifactId, ctx.userId);
  if (!parent) throw new Error("Artifact not found");
  if (parent.kind !== "sheet") throw new Error("Not a sheet artifact");
  const parentContent = fromJson<SheetContent>(parent.content);
  if (!parentContent?.columns?.length) throw new Error("Sheet has no columns to revise");

  const model = MODELS.cheap;
  const current: SheetContent = {
    columns: parentContent.columns,
    rows: Array.isArray(parentContent.rows) ? parentContent.rows : [],
  };
  const { json, shownRows, truncated } = serializeSheetForPrompt(current);

  ctx.emit({ type: "status", label: "Rethinking the sheet" });
  const revised = await callLLMJSON<{ columns?: unknown; rows?: unknown }>({
    system: [
      "You are revising an existing spreadsheet. Apply the user's instruction and return the FULL updated sheet.",
      'Output JSON: {"columns": [{"name": string, "type": "text"|"number"|"date"|"url"}], "rows": [[...cell values...]]}.',
      "Every row must have exactly one value per column, in column order.",
      "Preserve columns and rows the instruction doesn't touch. number cells as bare numbers, dates as YYYY-MM-DD, urls as https:// links, null for unknowns.",
    ].join("\n"),
    prompt: [
      `Instruction: ${instruction}`,
      truncated
        ? `Current sheet (JSON — truncated to the first ${shownRows} of ${current.rows.length} rows; revise as if the full sheet followed the same pattern):`
        : "Current sheet (JSON):",
      json,
    ].join("\n\n"),
    model,
    maxTokens: 12_000,
  });
  if (ctx.signal.aborted) throw new Error("aborted");

  const columns = normalizeColumns(revised?.columns);
  if (columns.length === 0) throw new Error("Revision produced no columns");
  const rows = normalizeRows(revised?.rows, columns);
  if (rows.length === 0) throw new Error("Revision produced no rows");

  ctx.emit({ type: "status", label: "Saving revision" });
  const content: SheetContent = { columns, rows };
  const row = insertArtifact({
    userId: ctx.userId,
    kind: "sheet",
    title: parent.title,
    content,
    hubId: parent.hub_id,
    parentId: parent.id,
    meta: {
      ...(fromJson<Record<string, unknown>>(parent.meta) ?? {}),
      model,
      rows: rows.length,
      columns: columns.length,
      revised_from: parent.id,
      instruction,
    },
  });
  return toArtifactSummary(row);
}

// ─── Generator ──────────────────────────────────────────────────────

export const sheetGenerator: GeneratorService<SheetInput> = {
  name: "sheet",
  inputSchema: SheetInputSchema,
  toolDescription:
    "Create a spreadsheet/table of structured data from a prompt (typed columns + AI-filled rows); optionally grounded in a hub's files.",
  run: runSheet,
  revise: reviseSheet,
};
