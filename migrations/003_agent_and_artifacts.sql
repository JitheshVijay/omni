-- Super Agent runs/steps (engine schema) and generated artifacts.
-- Phase 1 ships the schema + read-only routes; the engine lands in Phase 3.

CREATE TABLE IF NOT EXISTS agent_runs (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  hub_id               TEXT REFERENCES hubs(id) ON DELETE SET NULL,
  thread_id            TEXT REFERENCES chat_threads(id) ON DELETE SET NULL,
  title                TEXT,
  goal                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','planning','running','awaiting_confirmation',
                                           'paused','completed','failed','cancelled')),
  -- Model-maintained checklist: [{id, title, status, note}]
  plan                 TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(plan)),
  -- Exact LLM message array, checkpointed at every iteration boundary and
  -- suspension point; the resume/crash-recovery anchor.
  context_snapshot     TEXT CHECK (context_snapshot IS NULL OR json_valid(context_snapshot)),
  -- {card_id, tool_call_id, tool_name, args, description, reason, remaining_calls}
  pending_confirmation TEXT CHECK (pending_confirmation IS NULL OR json_valid(pending_confirmation)),
  model                TEXT,
  iter_count           INTEGER NOT NULL DEFAULT 0,
  max_iterations       INTEGER NOT NULL DEFAULT 40,
  budget_usd           REAL NOT NULL DEFAULT 1.5,
  cost_usd             REAL NOT NULL DEFAULT 0,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  final_output         TEXT,
  error                TEXT,
  resumable            INTEGER NOT NULL DEFAULT 0 CHECK (resumable IN (0,1)),
  cancel_requested     INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  pause_requested      INTEGER NOT NULL DEFAULT 0 CHECK (pause_requested IN (0,1)),
  claimed_at           TEXT,
  last_event_seq       INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at           TEXT,
  finished_at          TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_user_idx ON agent_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_active_idx
  ON agent_runs (status, claimed_at)
  WHERE status IN ('queued','planning','running','awaiting_confirmation');

CREATE TABLE IF NOT EXISTS agent_steps (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL,
  -- Monotonic per run; doubles as the SSE event id for Last-Event-ID replay.
  seq               INTEGER NOT NULL,
  iter              INTEGER NOT NULL DEFAULT 0,
  kind              TEXT NOT NULL CHECK (kind IN (
    'run_started','plan_updated','assistant_message','tool_call','tool_result',
    'artifact_created','confirmation_required','confirmation_resolved',
    'compaction','budget_warning','run_paused','run_resumed',
    'run_completed','run_failed','run_cancelled')),
  tool_name         TEXT,
  tool_args         TEXT CHECK (tool_args IS NULL OR json_valid(tool_args)),
  status            TEXT CHECK (status IS NULL OR status IN ('running','ok','error','skipped')),
  -- Capped payload (what the LLM saw) or prose.
  content           TEXT,
  -- Spill path under ${OMNI_DATA_DIR}/runs/<runId>/ when the result exceeded 64KB.
  full_content_path TEXT,
  -- One-liner used after context elision and in the timeline UI.
  summary           TEXT,
  cost_usd          REAL,
  duration_ms       INTEGER,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS agent_steps_run_seq_idx ON agent_steps (run_id, seq);

CREATE TABLE IF NOT EXISTS artifacts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  run_id        TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  thread_id     TEXT REFERENCES chat_threads(id) ON DELETE SET NULL,
  hub_id        TEXT REFERENCES hubs(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('doc','slides','image','sheet','audio','webpage')),
  title         TEXT NOT NULL,
  -- Inline structured content (BlockNote doc JSON, slide JSON, sheet JSON...).
  content       TEXT CHECK (content IS NULL OR json_valid(content)),
  -- 'artifacts/<uuid>.<ext>' relative to the data root, when a blob exists.
  rel_path      TEXT,
  drive_file_id TEXT REFERENCES drive_files(id) ON DELETE SET NULL,
  -- Edit lineage: the artifact this one was derived from.
  parent_id     TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  meta          TEXT CHECK (meta IS NULL OR json_valid(meta)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS artifacts_user_idx ON artifacts (user_id, created_at DESC);
