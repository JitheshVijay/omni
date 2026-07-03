-- Core workspace: hubs, chat threads/messages, user settings.
-- Conventions: TEXT uuid ids (app-generated), TEXT ISO-8601 UTC timestamps,
-- JSON as TEXT with json_valid CHECKs, booleans as INTEGER 0/1.

CREATE TABLE IF NOT EXISTS hubs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  -- Custom instructions prepended to the system prompt of every thread in the hub.
  instructions  TEXT,
  -- Per-hub default model override (OpenRouter id); null = user default.
  default_model TEXT,
  archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS hubs_user_idx ON hubs (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_threads (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  hub_id       TEXT REFERENCES hubs(id) ON DELETE SET NULL,
  title        TEXT NOT NULL DEFAULT 'New chat',
  model        TEXT NOT NULL,
  usage_totals TEXT NOT NULL DEFAULT '{"input_tokens":0,"output_tokens":0,"cost_usd":0}'
                 CHECK (json_valid(usage_totals)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS chat_threads_user_idx ON chat_threads (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS chat_threads_hub_idx ON chat_threads (hub_id) WHERE hub_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_messages (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content      TEXT NOT NULL DEFAULT '',
  -- Model that produced an assistant message (null for user messages).
  model        TEXT,
  -- TokenUsage: {input_tokens, output_tokens, total_tokens, cost_usd, model,
  --              cache_read_tokens?, cache_write_tokens?}
  usage        TEXT CHECK (usage IS NULL OR json_valid(usage)),
  -- [{id, name, arguments, result, started_at, finished_at, status}]
  tool_calls   TEXT CHECK (tool_calls IS NULL OR json_valid(tool_calls)),
  -- [{file_id, name, mime}] (drive_files ids)
  attachments  TEXT CHECK (attachments IS NULL OR json_valid(attachments)),
  -- [{chunk_id, file_id, cite_label, score}]
  citations    TEXT CHECK (citations IS NULL OR json_valid(citations)),
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS chat_messages_thread_idx ON chat_messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id       TEXT PRIMARY KEY,
  default_model TEXT NOT NULL DEFAULT 'anthropic/claude-sonnet-5',
  theme         TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
