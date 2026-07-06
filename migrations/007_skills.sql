-- Skills library: reusable AI tools for specific jobs. A skill is a saved,
-- reusable instruction (prompt_template, which may carry a {{input}}
-- placeholder) targeting a generator (doc/slides/sheet/image) or chat. The
-- curated built-in set is seeded in code (lib/skills-seed.ts) with stable ids
-- like 'builtin:daily-call-list' via INSERT OR IGNORE, so re-seeding is
-- idempotent. Users create their own skills (publisher 'You', is_builtin 0).
-- Conventions mirror migrations/002_drive_and_memory.sql (TEXT ids, TEXT ISO
-- timestamps defaulting via strftime, JSON-free flat columns).

CREATE TABLE IF NOT EXISTS skills (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  -- 'You' for user-created skills; 'Omni' / 'Anthropic' / 'OpenAI' for seeded.
  publisher       TEXT NOT NULL DEFAULT 'You',
  -- Persona this skill is for; drives the Role filter.
  role            TEXT NOT NULL DEFAULT 'General'
                    CHECK (role IN ('Sales','Marketer','Product','Researcher',
                                    'Designer','Engineer','Founder','General')),
  -- What the skill produces; drives the Output filter + card tint.
  output          TEXT NOT NULL DEFAULT 'chat'
                    CHECK (output IN ('doc','slides','sheet','image','chat','data')),
  -- A registered generator name, or 'chat' to hand off to a new chat thread.
  target          TEXT NOT NULL DEFAULT 'chat',
  -- The reusable instruction; may contain a single {{input}} placeholder.
  prompt_template TEXT NOT NULL,
  -- Gradient utility classes used to tint the card preview (e.g.
  -- 'from-sky-500 to-accent').
  accent          TEXT NOT NULL DEFAULT 'from-accent to-accent2',
  is_builtin      INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS skills_user_idx ON skills (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS skills_output_idx ON skills (output);
CREATE INDEX IF NOT EXISTS skills_role_idx ON skills (role);
