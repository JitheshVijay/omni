-- Custom Agents store: ready-made Super-Agent presets (a goal template + a
-- budget) you can launch in one click, plus save-your-own. A preset is a saved
-- goal_template (which may carry a {{input}} placeholder the launch route
-- substitutes) with a default budget. Launching a preset creates a real
-- agent_runs row and starts the orchestrator, exactly like /agent.
--
-- The curated built-in set is seeded in code (lib/agent-presets-seed.ts) with
-- stable ids like 'builtin:deep-research' via INSERT OR IGNORE, so re-seeding
-- is idempotent. Users create their own presets (publisher 'You',
-- is_builtin 0). Conventions mirror migrations/007_skills.sql (TEXT ids, TEXT
-- ISO timestamps defaulting via strftime, JSON-free flat columns).

CREATE TABLE IF NOT EXISTS agent_presets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  -- Groups presets in the store's category filter.
  category      TEXT NOT NULL DEFAULT 'Research',
  -- A lucide icon name string used to render the card badge.
  icon          TEXT NOT NULL DEFAULT 'Bot',
  -- Gradient utility classes used to tint the card badge (e.g.
  -- 'from-accent to-accent2').
  accent        TEXT NOT NULL DEFAULT 'from-accent to-accent2',
  -- The agent goal; may contain a single {{input}} placeholder for a topic.
  goal_template TEXT NOT NULL,
  -- Default spend cap handed to the run when launched.
  budget_usd    REAL NOT NULL DEFAULT 1.5,
  -- 'You' for user-created presets; 'Omni' / 'Anthropic' / 'OpenAI' for seeded.
  publisher     TEXT NOT NULL DEFAULT 'You',
  is_builtin    INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS agent_presets_user_idx ON agent_presets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_presets_category_idx ON agent_presets (category);
