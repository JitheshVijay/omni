-- AI Drive (metadata; blobs live at ${OMNI_DATA_DIR}/<rel_path>) and Hub memory
-- (chunks + embeddings). The vec0 virtual table and its cleanup trigger are
-- created in code (ensureVecIndex) so these migrations apply even when the
-- sqlite-vec extension fails to load.

CREATE TABLE IF NOT EXISTS drive_files (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  -- 'drive/<uuid>.<ext>' relative to the data root, so the root can move.
  rel_path      TEXT NOT NULL UNIQUE,
  origin        TEXT NOT NULL DEFAULT 'upload' CHECK (origin IN ('upload','generated','url')),
  -- Text-extraction/embedding pipeline state, driven by lib/drive-index.ts:
  -- pending -> extracting -> embedding -> ready | failed | skipped (non-text mime)
  index_status  TEXT NOT NULL DEFAULT 'pending'
                  CHECK (index_status IN ('pending','extracting','embedding','ready','failed','skipped')),
  index_error   TEXT,
  -- Indexer re-entrancy guard (5-min stale retake; boot resets stuck rows to pending).
  claimed_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS drive_files_user_idx ON drive_files (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS drive_files_claimable_idx
  ON drive_files (index_status, claimed_at)
  WHERE index_status IN ('pending','extracting','embedding');

CREATE TABLE IF NOT EXISTS hub_files (
  hub_id      TEXT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
  file_id     TEXT NOT NULL REFERENCES drive_files(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (hub_id, file_id)
);
CREATE INDEX IF NOT EXISTS hub_files_file_idx ON hub_files (file_id);

CREATE TABLE IF NOT EXISTS hub_memory_chunks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  hub_id        TEXT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
  file_id       TEXT REFERENCES drive_files(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('file','chat','note')),
  chunk_idx     INTEGER NOT NULL,
  chunk_text    TEXT NOT NULL,
  cite_label    TEXT NOT NULL,
  section_title TEXT,
  -- Float32Array(1536) bytes; source of truth (vec0 index is rebuildable).
  embedding     BLOB,
  -- rowid in vec_hub_memory (null when sqlite-vec unavailable).
  vec_rowid     INTEGER,
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (hub_id, file_id, chunk_idx)
);
CREATE INDEX IF NOT EXISTS hub_memory_chunks_hub_idx ON hub_memory_chunks (hub_id);
CREATE INDEX IF NOT EXISTS hub_memory_chunks_file_idx ON hub_memory_chunks (file_id);
