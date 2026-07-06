// AgentBase generation + persistence. Two ways to create a "system":
//
//   1. generateSystem(userId, prompt) — the "just describe it" flow. One
//      callLLMJSON turns a natural-language description into a SystemBlueprint
//      (name/category/icon/accent + 1-2 tables with typed columns & seed rows +
//      3-4 dashboard tiles), which is then persisted.
//   2. cloneTemplate(userId, template) — copies a curated AGENTBASE_TEMPLATES
//      blueprint verbatim (no LLM).
//
// Both funnel through persistSystem(), the single routine that writes the
// systems / system_tables / system_records / system_tiles rows inside one
// transaction and maps each tile.tableName -> the created table_id. The LLM
// output is sanitized (unknown column types coerced to text, tiles whose
// table/field/group_by don't resolve dropped) so a sloppy generation still
// yields a valid, renderable system.

import { all, run as dbRun, one, toJson, tx, uuid } from "@omni/sdk";
import { callLLMJSON, MODELS } from "@omni/sdk";
import {
  AGENTBASE_CATEGORIES,
  type AgentBaseTemplate,
  type ColumnType,
  type TemplateColumn,
  type TemplateTile,
  type TileAgg,
  type TileKind,
} from "./agentbase-templates.js";

const COLUMN_TYPES: ColumnType[] = ["text", "number", "date", "select", "url", "currency"];
const TILE_KINDS: TileKind[] = ["stat", "bar", "donut"];
const TILE_AGGS: TileAgg[] = ["count", "sum", "avg"];

// A ready-to-persist system shape. Both the LLM path and template path produce
// this (a template is just a blueprint with a stable id we ignore here).
export interface SystemBlueprint {
  name: string;
  description: string;
  category: string;
  icon: string;
  accent: string;
  tables: {
    name: string;
    columns: TemplateColumn[];
    sampleRows: Record<string, string | number>[];
  }[];
  tiles: TemplateTile[];
}

// ─── Sanitization ─────────────────────────────────────────────────────

function slugKey(raw: string, fallback: string): string {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || fallback;
}

function sanitizeColumns(raw: unknown): TemplateColumn[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const cols: TemplateColumn[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as Record<string, unknown>;
    if (!c || typeof c !== "object") continue;
    const label = String(c.label ?? c.key ?? `Field ${i + 1}`).slice(0, 60);
    let key = slugKey(String(c.key ?? label), `col_${i + 1}`);
    while (seen.has(key)) key = `${key}_${i + 1}`;
    seen.add(key);
    const type = (COLUMN_TYPES as string[]).includes(String(c.type))
      ? (c.type as ColumnType)
      : "text";
    const col: TemplateColumn = { key, label, type };
    if (type === "select" && Array.isArray(c.options)) {
      const options = c.options
        .map((o) => String(o).slice(0, 60))
        .filter((o) => o.length > 0)
        .slice(0, 24);
      if (options.length) col.options = options;
    }
    cols.push(col);
  }
  return cols.slice(0, 12);
}

// Keep only values whose keys are real columns; coerce numeric-typed cells to
// numbers so tile sum/avg math works regardless of how the model quoted them.
function sanitizeRow(
  raw: unknown,
  columns: TemplateColumn[],
): Record<string, string | number> {
  const row: Record<string, string | number> = {};
  if (!raw || typeof raw !== "object") return row;
  const obj = raw as Record<string, unknown>;
  for (const col of columns) {
    const v = obj[col.key];
    if (v === undefined || v === null) continue;
    if (col.type === "number" || col.type === "currency") {
      const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
      row[col.key] = Number.isFinite(n) ? n : 0;
    } else {
      row[col.key] = String(v).slice(0, 500);
    }
  }
  return row;
}

function sanitizeTiles(
  raw: unknown,
  tableColumns: Map<string, TemplateColumn[]>,
): TemplateTile[] {
  if (!Array.isArray(raw)) return [];
  const tableNames = Array.from(tableColumns.keys());
  const tiles: TemplateTile[] = [];
  for (const t of raw as Record<string, unknown>[]) {
    if (!t || typeof t !== "object") continue;
    const kind = (TILE_KINDS as string[]).includes(String(t.kind))
      ? (t.kind as TileKind)
      : "stat";
    // Resolve the table (fall back to the first table if the name is off).
    let tableName = String(t.tableName ?? "");
    if (!tableColumns.has(tableName)) {
      const ci = tableNames.find((n) => n.toLowerCase() === tableName.toLowerCase());
      tableName = ci ?? tableNames[0] ?? "";
    }
    if (!tableName) continue;
    const cols = tableColumns.get(tableName) ?? [];
    const cfg = (t.config ?? {}) as Record<string, unknown>;
    const agg = (TILE_AGGS as string[]).includes(String(cfg.agg))
      ? (cfg.agg as TileAgg)
      : "count";

    const config: TemplateTile["config"] = { agg };
    // field must be a numeric column for sum/avg.
    if (agg === "sum" || agg === "avg") {
      const field = String(cfg.field ?? "");
      const numCol = cols.find(
        (c) => c.key === field && (c.type === "number" || c.type === "currency"),
      );
      const anyNum = cols.find((c) => c.type === "number" || c.type === "currency");
      const resolved = numCol?.key ?? anyNum?.key;
      if (!resolved) continue; // sum/avg needs a numeric column; skip tile
      config.field = resolved;
    }
    // group_by must be a real column for bar/donut.
    if (kind === "bar" || kind === "donut") {
      const gb = String(cfg.group_by ?? "");
      const col = cols.find((c) => c.key === gb);
      const fallback =
        cols.find((c) => c.type === "select") ?? cols.find((c) => c.type === "text");
      const resolved = col?.key ?? fallback?.key;
      if (!resolved) continue; // no groupable column; skip tile
      config.group_by = resolved;
    }
    tiles.push({
      title: String(t.title ?? "Metric").slice(0, 80),
      kind,
      tableName,
      config,
    });
    if (tiles.length >= 6) break;
  }
  return tiles;
}

// Turn any candidate object (LLM output or template) into a clean blueprint.
export function sanitizeBlueprint(raw: unknown): SystemBlueprint {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawTables = Array.isArray(obj.tables) ? obj.tables : [];
  const tableColumns = new Map<string, TemplateColumn[]>();
  const tables: SystemBlueprint["tables"] = [];

  for (const t of rawTables.slice(0, 2) as Record<string, unknown>[]) {
    if (!t || typeof t !== "object") continue;
    const name = String(t.name ?? "Records").slice(0, 60) || "Records";
    const columns = sanitizeColumns(t.columns);
    if (!columns.length) continue;
    const uniqueName = tableColumns.has(name) ? `${name} 2` : name;
    tableColumns.set(uniqueName, columns);
    const rawRows = Array.isArray(t.sampleRows) ? t.sampleRows : [];
    const sampleRows = rawRows.slice(0, 12).map((r) => sanitizeRow(r, columns));
    tables.push({ name: uniqueName, columns, sampleRows });
  }

  const category =
    (AGENTBASE_CATEGORIES as readonly string[]).includes(String(obj.category))
      ? String(obj.category)
      : "General";

  return {
    name: String(obj.name ?? "Untitled System").slice(0, 120) || "Untitled System",
    description: String(obj.description ?? "").slice(0, 500),
    category,
    icon: String(obj.icon ?? "LayoutDashboard").slice(0, 40) || "LayoutDashboard",
    accent: String(obj.accent ?? "from-accent to-accent2").slice(0, 80),
    tables,
    tiles: sanitizeTiles(obj.tiles, tableColumns),
  };
}

// ─── Persistence ──────────────────────────────────────────────────────

// Write a blueprint into the four AgentBase tables inside one transaction and
// return the new system id. Shared by the LLM and template-clone paths.
export function persistSystem(userId: string, blueprint: SystemBlueprint): string {
  const clean = sanitizeBlueprint(blueprint);
  if (clean.tables.length === 0) {
    throw new Error("System has no valid tables to create.");
  }
  const systemId = uuid();

  tx(() => {
    dbRun(
      `INSERT INTO systems (id, user_id, name, description, category, icon, accent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      systemId,
      userId,
      clean.name,
      clean.description,
      clean.category,
      clean.icon,
      clean.accent,
    );

    const tableIdByName = new Map<string, string>();
    clean.tables.forEach((t, ti) => {
      const tableId = uuid();
      tableIdByName.set(t.name, tableId);
      dbRun(
        `INSERT INTO system_tables (id, system_id, user_id, name, columns, position)
         VALUES (?, ?, ?, ?, ?, ?)`,
        tableId,
        systemId,
        userId,
        t.name,
        toJson(t.columns),
        ti,
      );
      for (const rowData of t.sampleRows) {
        dbRun(
          `INSERT INTO system_records (id, table_id, system_id, user_id, data)
           VALUES (?, ?, ?, ?, ?)`,
          uuid(),
          tableId,
          systemId,
          userId,
          toJson(rowData),
        );
      }
    });

    clean.tiles.forEach((tile, i) => {
      const tableId = tableIdByName.get(tile.tableName);
      if (!tableId) return;
      dbRun(
        `INSERT INTO system_tiles
           (id, system_id, user_id, title, kind, table_id, config, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        uuid(),
        systemId,
        userId,
        tile.title,
        tile.kind,
        tableId,
        toJson(tile.config),
        i,
      );
    });
  });

  return systemId;
}

export function cloneTemplate(userId: string, template: AgentBaseTemplate): string {
  return persistSystem(userId, {
    name: template.name,
    description: template.description,
    category: template.category,
    icon: template.icon,
    accent: template.accent,
    tables: template.tables,
    tiles: template.tiles,
  });
}

// ─── LLM generation ───────────────────────────────────────────────────

const GEN_SYSTEM = `You are AgentBase, a tool that turns a plain-language description into a lightweight custom "system" — a dashboard/CRM made of data TABLES plus summary DASHBOARD TILES.

Given the user's description, design a practical, immediately-useful system and return it as JSON with this exact shape:
{
  "name": string,               // short, e.g. "Freelance Client CRM"
  "description": string,        // one sentence on what it tracks
  "category": one of ["Sales & CRM","Inventory","Projects","Marketing","HR","Personal","General"],
  "icon": string,               // a lucide-react icon name, e.g. "Users", "Wallet", "Bug", "Boxes", "CalendarDays", "ListChecks"
  "accent": string,             // tailwind gradient classes like "from-indigo-500 to-accent2" or "from-emerald-500 to-teal-400"
  "tables": [
    {
      "name": string,           // e.g. "Clients"
      "columns": [
        { "key": string,        // snake_case identifier, unique within the table
          "label": string,      // human label
          "type": one of ["text","number","date","select","url","currency"],
          "options": string[]   // ONLY when type is "select" — the allowed values
        }
      ],
      "sampleRows": [ { "<column key>": value, ... } ]  // realistic example records
    }
  ],
  "tiles": [
    { "title": string,
      "kind": one of ["stat","bar","donut"],
      "tableName": string,      // must match one of the tables above
      "config": { "agg": one of ["count","sum","avg"], "field": string?, "group_by": string? }
    }
  ]
}

Rules:
- Design 1 table (2 only if the domain clearly needs a second). Give each table 4-6 well-chosen columns. Prefer a "select" column with sensible options for any status/stage/category field — this powers the charts.
- Provide 5-8 realistic sampleRows per table. Every value's key MUST be a column key. Numeric/currency values must be plain numbers (no "$", no commas).
- Design 3-4 tiles. A "stat" tile shows one number (agg count, or sum/avg over a numeric "field"). A "bar" or "donut" tile MUST set "group_by" to a column key (usually the select column) and uses agg count, or sum/avg over a numeric "field".
- For sum/avg tiles, "field" MUST be a number or currency column key. For bar/donut, "group_by" MUST be a real column key.
- Make it genuinely useful and specific to the request. Do not add commentary — return only the JSON object.`;

export async function generateSystem(userId: string, prompt: string): Promise<string> {
  const blueprint = await callLLMJSON<Record<string, unknown>>({
    system: GEN_SYSTEM,
    prompt: `Design a system for this description:\n\n"""${prompt.trim()}"""`,
    model: MODELS.default,
    maxTokens: 4096,
  });
  const clean = sanitizeBlueprint(blueprint);
  return persistSystem(userId, clean);
}

// ─── Tile computation (shared by the routes) ──────────────────────────

export interface ComputedTilePoint {
  label: string;
  value: number;
}

export interface ComputedTile {
  id: string;
  title: string;
  kind: TileKind;
  table_id: string | null;
  config: TemplateTile["config"];
  /** For a stat tile: the single number. */
  value: number | null;
  /** For bar/donut tiles: the grouped series. */
  points: ComputedTilePoint[];
}

interface TileRow {
  id: string;
  title: string;
  kind: string;
  table_id: string | null;
  config: string;
}

// Compute a tile's value(s) over its table's records. Pure aggregation in JS
// so the detail response ships render-ready numbers.
export function computeTile(
  tile: TileRow,
  records: Record<string, string | number>[],
): ComputedTile {
  const config = (() => {
    try {
      return JSON.parse(tile.config) as TemplateTile["config"];
    } catch {
      return { agg: "count" } as TemplateTile["config"];
    }
  })();
  const kind = (TILE_KINDS as string[]).includes(tile.kind)
    ? (tile.kind as TileKind)
    : "stat";
  const agg = config.agg ?? "count";

  const num = (r: Record<string, string | number>, field?: string): number => {
    if (!field) return 0;
    const v = r[field];
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const aggregate = (rows: Record<string, string | number>[]): number => {
    if (agg === "count") return rows.length;
    const sum = rows.reduce((acc, r) => acc + num(r, config.field), 0);
    if (agg === "avg") return rows.length ? sum / rows.length : 0;
    return sum;
  };

  const base: ComputedTile = {
    id: tile.id,
    title: tile.title,
    kind,
    table_id: tile.table_id,
    config,
    value: null,
    points: [],
  };

  if (kind === "stat") {
    base.value = round(aggregate(records));
    return base;
  }

  // bar / donut — group by a column, aggregate each bucket.
  const groups = new Map<string, Record<string, string | number>[]>();
  const gb = config.group_by;
  for (const r of records) {
    const key = gb ? String(r[gb] ?? "—") : "—";
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }
  base.points = Array.from(groups.entries())
    .map(([label, rows]) => ({ label, value: round(aggregate(rows)) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  return base;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Load + compute all tiles for a system. Reused by the detail route.
export function computeSystemTiles(systemId: string): ComputedTile[] {
  const tiles = all<TileRow>(
    "SELECT id, title, kind, table_id, config FROM system_tiles WHERE system_id = ? ORDER BY position ASC",
    systemId,
  );
  // Cache records per table so N tiles over the same table read once.
  const recordsByTable = new Map<string, Record<string, string | number>[]>();
  const loadRecords = (tableId: string | null): Record<string, string | number>[] => {
    if (!tableId) return [];
    const cached = recordsByTable.get(tableId);
    if (cached) return cached;
    const rows = all<{ data: string }>(
      "SELECT data FROM system_records WHERE table_id = ?",
      tableId,
    ).map((r) => {
      try {
        return JSON.parse(r.data) as Record<string, string | number>;
      } catch {
        return {} as Record<string, string | number>;
      }
    });
    recordsByTable.set(tableId, rows);
    return rows;
  };

  return tiles.map((t) => computeTile(t, loadRecords(t.table_id)));
}

// Small helper the routes use to touch updated_at when a system changes.
export function touchSystem(systemId: string): void {
  const exists = one<{ id: string }>("SELECT id FROM systems WHERE id = ?", systemId);
  if (exists) {
    dbRun(
      "UPDATE systems SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      systemId,
    );
  }
}
