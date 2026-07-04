-- Global semantic search: a unified index over "search items" spanning Drive
-- files, generated artifacts, chat threads, and hub memory chunks. Each row
-- carries a title + snippet and (when embeddings are available) a Float32Array
-- embedding BLOB — the source of truth. The vec0 companion table
-- (vec_search_items) and its cleanup trigger are created in code
-- (ensureSearchVecIndex) so this migration applies even when sqlite-vec fails
-- to load. Conventions mirror migrations/002_drive_and_memory.sql.

CREATE TABLE IF NOT EXISTS search_items (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  -- Source table the item points at (ref_id is that row's id).
  kind          TEXT NOT NULL CHECK (kind IN ('drive','artifact','thread','hub_chunk')),
  ref_id        TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  snippet       TEXT NOT NULL DEFAULT '',
  -- Float32Array(1536) bytes of embed(title + snippet); null when embeddings
  -- were unavailable at index time (keyword search still finds the row).
  embedding     BLOB,
  -- rowid in vec_search_items (null when sqlite-vec unavailable / embed failed).
  vec_rowid     INTEGER,
  -- sha256(title + snippet); lets reindexAll skip unchanged items.
  content_hash  TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (kind, ref_id)
);
CREATE INDEX IF NOT EXISTS search_items_user_idx ON search_items (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS search_items_ref_idx ON search_items (kind, ref_id);
