// Shared types + pure helpers for AI Sheets (kind='sheet' artifacts).
// Mirrors the server-side content shape in apps/api/src/generators/sheet.ts:
//   artifacts.content = { columns: [{name, type}], rows: cell[][] }
// rows are arrays of cells aligned to `columns`; number-typed cells are
// stored as JS numbers where they parse. No formulas in v1.

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

/** Validate that an artifact's content really is a sheet we can render. */
export function asSheet(content: unknown): SheetContent | null {
  if (!content || typeof content !== "object") return null;
  const c = content as Partial<SheetContent>;
  if (!Array.isArray(c.columns) || c.columns.length === 0) return null;
  if (!Array.isArray(c.rows)) return null;
  const columns: SheetColumn[] = c.columns
    .filter((col): col is SheetColumn => !!col && typeof col === "object")
    .map((col) => ({
      name: String(col.name ?? ""),
      type: (SHEET_COLUMN_TYPES as readonly string[]).includes(String(col.type))
        ? (col.type as SheetColumnType)
        : "text",
    }));
  if (columns.length === 0) return null;
  // Align every row to the column count so the grid never renders ragged.
  const rows: SheetCell[][] = c.rows
    .filter((r): r is SheetCell[] => Array.isArray(r))
    .map((r) => {
      const cells = r.slice(0, columns.length).map(normalizeCell);
      while (cells.length < columns.length) cells.push(null);
      return cells;
    });
  return { columns, rows };
}

function normalizeCell(v: unknown): SheetCell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(v);
}

/** Commit a cell edit: number columns parse numeric input ("1,200", "$5",
 *  "45%") into JS numbers; empty input clears the cell to null. */
export function coerceCellInput(raw: string, type: SheetColumnType): SheetCell {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (type === "number") {
    const cleaned = trimmed.replace(/^[$€£]\s*/, "").replace(/%$/, "").replace(/,/g, "");
    if (cleaned !== "" && Number.isFinite(Number(cleaned))) return Number(cleaned);
  }
  return trimmed;
}

export function cellToDisplay(cell: SheetCell): string {
  if (cell === null || cell === undefined) return "";
  return String(cell);
}

export function isHttpUrl(v: SheetCell): v is string {
  return typeof v === "string" && /^https?:\/\//i.test(v.trim());
}

// ─── CSV export (hand-rolled) ───────────────────────────────────────

function csvField(v: SheetCell): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC-4180 CSV with a UTF-8 BOM (so Excel detects the encoding) and CRLF
 *  line endings. Fields containing quotes/commas/newlines are quoted. */
export function buildCsv(columns: SheetColumn[], rows: SheetCell[][]): string {
  const lines = [columns.map((c) => csvField(c.name)).join(",")];
  for (const r of rows) {
    lines.push(columns.map((_, i) => csvField(r[i] ?? null)).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
