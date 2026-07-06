-- AgentBase: "Dashboards & CRM". A user describes a workflow (or picks a
-- template) and the LLM generates a lightweight "system": a named workspace
-- holding one or more TABLES (a typed column schema + rows of records) and a
-- set of DASHBOARD TILES (a stat number, bar chart, or donut derived from a
-- table). v1 generates the schema + seed rows from a prompt; the user can add
-- more rows. Conventions mirror migrations/004_workflows.sql and 007_skills.sql
-- (TEXT uuid ids, TEXT ISO timestamps via strftime, JSON stored as TEXT with a
-- json_valid CHECK, INTEGER booleans). Deletes cascade system -> tables ->
-- records and system -> tiles via ON DELETE CASCADE.

CREATE TABLE IF NOT EXISTS systems (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- Free-form grouping label (Sales & CRM / Inventory / Projects / ...).
  category    TEXT NOT NULL DEFAULT 'General',
  -- A lucide icon name the frontend maps to a component (e.g. 'LayoutDashboard').
  icon        TEXT NOT NULL DEFAULT 'LayoutDashboard',
  -- Gradient utility classes used to tint the system's preview / header.
  accent      TEXT NOT NULL DEFAULT 'from-accent to-accent2',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS systems_user_idx ON systems (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS system_tables (
  id         TEXT PRIMARY KEY,
  system_id  TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  -- [{key,label,type:"text"|"number"|"date"|"select"|"url"|"currency",options?}]
  columns    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(columns)),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS system_tables_system_idx ON system_tables (system_id, position);
CREATE INDEX IF NOT EXISTS system_tables_user_idx ON system_tables (user_id);

CREATE TABLE IF NOT EXISTS system_records (
  id         TEXT PRIMARY KEY,
  table_id   TEXT NOT NULL REFERENCES system_tables(id) ON DELETE CASCADE,
  system_id  TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  -- A flat object keyed by column.key -> value (string|number).
  data       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS system_records_table_idx ON system_records (table_id, created_at DESC);
CREATE INDEX IF NOT EXISTS system_records_system_idx ON system_records (system_id);
CREATE INDEX IF NOT EXISTS system_records_user_idx ON system_records (user_id);

CREATE TABLE IF NOT EXISTS system_tiles (
  id         TEXT PRIMARY KEY,
  system_id  TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'stat' CHECK (kind IN ('stat','bar','donut')),
  -- The table this tile aggregates over (nullable so an orphaned tile survives).
  table_id   TEXT REFERENCES system_tables(id) ON DELETE CASCADE,
  -- {agg:"count"|"sum"|"avg", field?, group_by?}
  config     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS system_tiles_system_idx ON system_tiles (system_id, position);
CREATE INDEX IF NOT EXISTS system_tiles_user_idx ON system_tiles (user_id);
