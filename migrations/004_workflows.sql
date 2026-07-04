-- Workflows: user-authored automation chains (v1 editor builds linear chains,
-- the runner executes any DAG), optional cron schedules (rehydrated at boot,
-- missed-while-closed runs are simply missed), and per-run step records.

CREATE TABLE IF NOT EXISTS workflows (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  -- {nodes:[{id, type:'agent_task'|'generate'|'search'|'read_url', config:{...}}],
  --  edges:[{from, to}]}
  graph       TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}' CHECK (json_valid(graph)),
  -- Cron expression (node-cron syntax); null = manual trigger only.
  schedule    TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  last_run_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS workflows_user_idx ON workflows (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','completed','failed','cancelled')),
  trigger     TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','cron')),
  error       TEXT,
  cost_usd    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at  TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS workflow_runs_wf_idx ON workflow_runs (workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_user_idx ON workflow_runs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  node_type   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','ok','error','skipped')),
  -- Compact result: {text?, artifact_id?, agent_run_id?, preview}
  output      TEXT CHECK (output IS NULL OR json_valid(output)),
  error       TEXT,
  started_at  TEXT,
  finished_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (run_id, seq)
);
