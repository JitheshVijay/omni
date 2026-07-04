-- External-app connections (Composio) for the AI Secretary. One row per
-- connected toolkit (gmail, googlecalendar) tracking the Composio
-- connected-account id and status. Tokens live in Composio, never here.

CREATE TABLE IF NOT EXISTS connections (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  -- Composio toolkit slug: 'gmail' | 'googlecalendar' | ...
  toolkit               TEXT NOT NULL,
  -- Composio connected-account id (ca_...); null while a connect is pending.
  connected_account_id  TEXT,
  -- 'pending' (hosted-auth link issued) | 'active' | 'error' | 'disconnected'
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','active','error','disconnected')),
  status_detail         TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, toolkit)
);
CREATE INDEX IF NOT EXISTS connections_user_idx ON connections (user_id);
