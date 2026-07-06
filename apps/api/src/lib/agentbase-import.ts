// AgentBase file ingestion — turn an uploaded CSV/TSV spreadsheet into a real
// working "system". This is the engine behind the "From files" source on the
// AgentBase home: parse the tabular bytes (RFC-4180-ish, quoted fields, CRLF)
// into a typed column schema + records, then persist it through the SAME path
// the LLM / template flows use (agentbase-gen's persistSystem), auto-suggesting
// a couple of dashboard tiles so the new system opens with a live dashboard.
//
// Scope note (v1): CSV and TSV (plain-text delimited) only. Real .xlsx is a
// binary/zip format that needs a parser dependency — out of scope here; callers
// should export to CSV. The delimiter is picked from the filename extension and
// falls back to sniffing the header line.

import { run as dbRun, one, toJson, uuid } from "@omni/sdk";
import { persistSystem, type SystemBlueprint } from "./agentbase-gen.js";
import type {
  ColumnType,
  TemplateColumn,
  TemplateTile,
} from "./agentbase-templates.js";

export interface ParsedTable {
  columns: TemplateColumn[];
  rows: Record<string, string | number>[];
}

// ─── Delimited parsing ────────────────────────────────────────────────

// RFC-4180-ish parser: handles quoted fields, escaped quotes (""), embedded
// commas/newlines inside quotes, and both LF and CRLF line endings. Returns a
// grid of raw string cells (header row included).
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Strip a leading UTF-8 BOM so the first header key isn't polluted.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === delim) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush the trailing field/row (file may not end in a newline).
  row.push(field);
  rows.push(row);

  // Drop rows that are entirely empty (e.g. a trailing blank line).
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function detectDelimiter(filename: string, firstLine: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tsv") || lower.endsWith(".tab")) return "\t";
  if (lower.endsWith(".csv")) return ",";
  // Ambiguous (e.g. .txt): sniff the header line.
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs > commas ? "\t" : ",";
}

// ─── Type inference ───────────────────────────────────────────────────

const CURRENCY_RE = /^[-+]?[$€£¥₹]\s?[\d,]+(\.\d+)?$|^[-+]?[\d,]+(\.\d+)?\s?(usd|eur|gbp|cad|aud)$/i;
const NUMBER_RE = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([ t]\d{2}:\d{2}(:\d{2})?)?/i;
const SLASH_DATE_RE = /^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/;

function looksNumeric(v: string): boolean {
  const s = v.trim();
  if (s === "") return false;
  return NUMBER_RE.test(s) && /\d/.test(s);
}

function looksCurrency(v: string): boolean {
  return CURRENCY_RE.test(v.trim());
}

function looksDate(v: string): boolean {
  const s = v.trim();
  if (!ISO_DATE_RE.test(s) && !SLASH_DATE_RE.test(s)) return false;
  return !Number.isNaN(Date.parse(s));
}

// Infer one column's type from a sample of its non-blank cell values. Order
// matters: currency (has a symbol) before number; date requires a date-shaped
// string so pure integers don't get misread as dates.
function inferType(values: string[]): ColumnType {
  const nonBlank = values.map((v) => v.trim()).filter((v) => v !== "");
  if (nonBlank.length === 0) return "text";
  const all = (fn: (v: string) => boolean) => nonBlank.every(fn);
  if (all(looksCurrency)) return "currency";
  if (all((v) => looksNumeric(v) || looksCurrency(v)) && nonBlank.some(looksNumeric))
    return "number";
  if (all(looksDate)) return "date";
  return "text";
}

function slugKey(raw: string, fallback: string): string {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || fallback;
}

function coerceCell(raw: string, type: ColumnType): string | number {
  if (type === "number" || type === "currency") {
    const n = Number(raw.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return raw.trim().slice(0, 500);
}

// Parse an uploaded CSV/TSV buffer into a typed column schema + coerced rows.
// Throws if there is no header row or no data rows (caller maps to a 400).
export function parseTabular(buffer: Buffer, filename: string): ParsedTable {
  const text = buffer.toString("utf8");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = detectDelimiter(filename, firstLine);
  const grid = parseDelimited(text, delim);

  if (grid.length < 2) {
    throw new Error("The file needs a header row and at least one data row.");
  }

  const header = grid[0];
  const seen = new Set<string>();
  const columns: TemplateColumn[] = [];
  const columnCells: string[][] = [];

  header.forEach((rawLabel, idx) => {
    const label = (rawLabel.trim() || `Field ${idx + 1}`).slice(0, 60);
    let key = slugKey(rawLabel, `col_${idx + 1}`);
    while (seen.has(key)) key = `${key}_${idx + 1}`;
    seen.add(key);
    // Sample up to 200 values from this column for type inference.
    const cells = grid.slice(1, 201).map((r) => r[idx] ?? "");
    columnCells[idx] = cells;
    columns.push({ key, label, type: inferType(cells) });
  });

  if (columns.length === 0) {
    throw new Error("Could not detect any columns in the file.");
  }

  const dataRows = grid.slice(1);
  const rows: Record<string, string | number>[] = dataRows.map((cells) => {
    const rec: Record<string, string | number> = {};
    columns.forEach((col, idx) => {
      const raw = cells[idx];
      if (raw === undefined || raw.trim() === "") return;
      rec[col.key] = coerceCell(raw, col.type);
    });
    return rec;
  });

  return { columns, rows };
}

// ─── Tile auto-suggestion ─────────────────────────────────────────────

// Pick a low-cardinality column good for grouping into a bar chart: a text
// column whose distinct value count is small relative to the row count.
function pickGroupColumn(
  columns: TemplateColumn[],
  rows: Record<string, string | number>[],
): TemplateColumn | undefined {
  const candidates = columns.filter((c) => c.type === "text" || c.type === "select");
  let best: { col: TemplateColumn; distinct: number } | undefined;
  for (const col of candidates) {
    const distinct = new Set(rows.map((r) => String(r[col.key] ?? "")).filter((v) => v !== ""));
    const n = distinct.size;
    if (n < 2 || n > 12) continue;
    // Prefer genuinely categorical columns (few distinct values vs many rows).
    if (rows.length >= 4 && n > Math.max(2, Math.ceil(rows.length / 2))) continue;
    if (!best || n < best.distinct) best = { col, distinct: n };
  }
  return best?.col;
}

function suggestTiles(
  tableName: string,
  columns: TemplateColumn[],
  rows: Record<string, string | number>[],
): TemplateTile[] {
  const tiles: TemplateTile[] = [];

  // 1) Always: a total-records count stat.
  tiles.push({
    title: "Total records",
    kind: "stat",
    tableName,
    config: { agg: "count" },
  });

  // 2) A sum over the first numeric/currency column, if any.
  const numCol = columns.find((c) => c.type === "number" || c.type === "currency");
  if (numCol) {
    tiles.push({
      title: `Total ${numCol.label}`,
      kind: "stat",
      tableName,
      config: { agg: "sum", field: numCol.key },
    });
  }

  // 3) A bar grouped by the first low-cardinality text column, if any.
  const groupCol = pickGroupColumn(columns, rows);
  if (groupCol) {
    tiles.push({
      title: `By ${groupCol.label}`,
      kind: "bar",
      tableName,
      config: numCol
        ? { agg: "sum", field: numCol.key, group_by: groupCol.key }
        : { agg: "count", group_by: groupCol.key },
    });
  }

  return tiles;
}

// ─── Build + persist ──────────────────────────────────────────────────

// Turn a parsed table into a persisted system and return its id. The schema +
// tiles go through agentbase-gen's persistSystem (so tile validation, table-id
// mapping and column sanitization are all reused) with an empty seed-row set —
// then EVERY parsed row is bulk-inserted directly, so real data is ingested in
// full rather than truncated by the blueprint's sample-row cap.
export function buildSystemFromTable(
  userId: string,
  name: string,
  table: ParsedTable,
): string {
  if (table.columns.length === 0) {
    throw new Error("No columns detected in the file.");
  }
  if (table.rows.length === 0) {
    throw new Error("No data rows detected in the file.");
  }

  const tableName = "Records";
  const blueprint: SystemBlueprint = {
    name: name.slice(0, 120) || "Imported System",
    description: `Imported from a spreadsheet — ${table.rows.length} records across ${table.columns.length} fields.`,
    category: "General",
    icon: "Table2",
    accent: "from-emerald-500 to-teal-400",
    tables: [{ name: tableName, columns: table.columns, sampleRows: [] }],
    tiles: suggestTiles(tableName, table.columns, table.rows),
  };

  const systemId = persistSystem(userId, blueprint);

  // Resolve the created table, then bulk-insert every parsed row. persistSystem
  // may cap the schema at its column limit; only insert values for columns that
  // actually made it into the persisted schema so records stay renderable.
  const created = one<{ id: string; columns: string }>(
    "SELECT id, columns FROM system_tables WHERE system_id = ? ORDER BY position ASC LIMIT 1",
    systemId,
  );
  if (created) {
    const keptKeys = new Set<string>(
      (JSON.parse(created.columns) as TemplateColumn[]).map((c) => c.key),
    );
    for (const row of table.rows) {
      const clean: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(row)) {
        if (keptKeys.has(k)) clean[k] = v;
      }
      dbRun(
        `INSERT INTO system_records (id, table_id, system_id, user_id, data)
         VALUES (?, ?, ?, ?, ?)`,
        uuid(),
        created.id,
        systemId,
        userId,
        toJson(clean),
      );
    }
  }

  return systemId;
}

// A human system name derived from an uploaded filename ("q3_sales.csv" ->
// "Q3 Sales"). Falls back to a generic label when nothing usable remains.
export function systemNameFromFilename(filename: string): string {
  const base = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) return "Imported System";
  return base
    .split(" ")
    .map((w) => (/\d/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ")
    .slice(0, 120);
}
