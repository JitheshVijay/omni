-- Full-stack App Builder projects. Each row is a generated multi-file app plus
-- the E2B sandbox it runs in and the public preview URL. `files` is the full
-- project as a JSON array of {path, content}. status 'no_sandbox' means codegen
-- succeeded but E2B_API_KEY is absent, so the code exists but isn't running.
CREATE TABLE IF NOT EXISTS app_projects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  summary     TEXT,
  files       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files)),
  sandbox_id  TEXT,
  preview_url TEXT,
  status      TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','generating','provisioning','installing','starting','ready','failed','no_sandbox')),
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_app_projects_user ON app_projects (user_id, updated_at DESC);
