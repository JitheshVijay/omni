// AgentBase client: the System / Table / Record / Tile / Column types plus thin
// authFetch wrappers over the /api/agentbase routes. The list + detail GETs are
// also read via useApi() (SWR) on the pages; these helpers cover the mutations
// (create from prompt or template, delete, add/edit/delete a record) and the
// template gallery fetch.

import { authFetch } from "@/lib/use-api";

export const AGENTBASE_CATEGORIES = [
  "Sales & CRM",
  "Inventory",
  "Projects",
  "Marketing",
  "HR",
  "Personal",
] as const;
export type SystemCategory = (typeof AGENTBASE_CATEGORIES)[number];

export const COLUMN_TYPES = ["text", "number", "date", "select", "url", "currency"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface Column {
  key: string;
  label: string;
  type: ColumnType;
  options?: string[];
}

export type TileKind = "stat" | "bar" | "donut";
export type TileAgg = "count" | "sum" | "avg";

export interface TileConfig {
  agg: TileAgg;
  field?: string;
  group_by?: string;
}

/** A record's data is a flat object keyed by column.key. */
export type RecordData = Record<string, string | number>;

export interface SystemRecord {
  id: string;
  table_id: string;
  data: RecordData;
  created_at: string;
  updated_at: string;
}

export interface SystemTable {
  id: string;
  name: string;
  columns: Column[];
  position: number;
  records: SystemRecord[];
}

export interface TilePoint {
  label: string;
  value: number;
}

/** A server-computed tile: `value` for stat, `points` for bar/donut. */
export interface Tile {
  id: string;
  title: string;
  kind: TileKind;
  table_id: string | null;
  config: TileConfig;
  value: number | null;
  points: TilePoint[];
}

/** A row in the "My Systems" grid (list endpoint, no tables/records). */
export interface SystemSummary {
  id: string;
  user_id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  accent: string;
  table_count: number;
  record_count: number;
  created_at: string;
  updated_at: string;
}

/** The full system returned by the detail endpoint. */
export interface System extends SystemSummary {
  tables: SystemTable[];
  tiles: Tile[];
}

/** A template in the gallery (blueprint + a light preview count). */
export interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  accent: string;
  tables: { name: string; columns: Column[]; row_count: number }[];
  tiles: { title: string; kind: TileKind; tableName: string; config: TileConfig }[];
}

export type CreateSystemBody = { prompt: string } | { from_template: string };

// ── Endpoints ─────────────────────────────────────────────────────────────

export const SYSTEMS_KEY = "/api/agentbase/systems";
export const TEMPLATES_KEY = "/api/agentbase/templates";

export function systemKey(id: string): string {
  return `/api/agentbase/systems/${id}`;
}

export function listSystems(): Promise<{ systems: SystemSummary[] }> {
  return authFetch<{ systems: SystemSummary[] }>(SYSTEMS_KEY);
}

export function getSystem(id: string): Promise<System> {
  return authFetch<System>(systemKey(id));
}

export function listTemplates(): Promise<{
  templates: Template[];
  categories: string[];
}> {
  return authFetch<{ templates: Template[]; categories: string[] }>(TEMPLATES_KEY);
}

export function createSystem(body: CreateSystemBody): Promise<SystemSummary> {
  return authFetch<SystemSummary>(SYSTEMS_KEY, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Build a real system from an uploaded CSV/TSV spreadsheet. Parses headers into
 * typed columns and rows into records server-side, then returns the bare system.
 */
export function createSystemFromFile(file: File, name?: string): Promise<SystemSummary> {
  const form = new FormData();
  form.append("file", file);
  if (name && name.trim()) form.append("name", name.trim());
  return authFetch<SystemSummary>(`${SYSTEMS_KEY}/from-file`, {
    method: "POST",
    body: form,
  });
}

export function deleteSystem(id: string): Promise<{ deleted: boolean }> {
  return authFetch<{ deleted: boolean }>(systemKey(id), { method: "DELETE" });
}

export function addRecord(
  systemId: string,
  tableId: string,
  data: RecordData,
): Promise<SystemRecord> {
  return authFetch<SystemRecord>(
    `${systemKey(systemId)}/tables/${tableId}/records`,
    { method: "POST", body: JSON.stringify({ data }) },
  );
}

export function updateRecord(
  systemId: string,
  recordId: string,
  data: RecordData,
): Promise<SystemRecord> {
  return authFetch<SystemRecord>(`${systemKey(systemId)}/records/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify({ data }),
  });
}

export function deleteRecord(
  systemId: string,
  recordId: string,
): Promise<{ deleted: boolean }> {
  return authFetch<{ deleted: boolean }>(
    `${systemKey(systemId)}/records/${recordId}`,
    { method: "DELETE" },
  );
}

// ── Formatting helpers (shared by the pages / tiles) ────────────────────────

/** Format a cell value for display based on its column type. */
export function formatCell(value: string | number | undefined, type: ColumnType): string {
  if (value === undefined || value === null || value === "") return "N/A";
  if (type === "currency") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return String(value);
    return n.toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: n % 1 === 0 ? 0 : 2,
    });
  }
  if (type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n.toLocaleString() : String(value);
  }
  return String(value);
}

/** Compact number for a big stat tile (1.2k, 3.4M). */
export function formatStat(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return (Math.round(n * 100) / 100).toLocaleString();
}
