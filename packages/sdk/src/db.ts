// SQLite singleton + helpers — the data layer for all of Omni.
//
// One better-sqlite3 Database per process (the `supabaseAdmin` equivalent
// from Flo101), opened on `${DATA_DIR}/omni.db` with WAL journaling and
// foreign keys ON. The sqlite-vec extension is loaded fail-soft: when it
// isn't available (unsupported platform, bad binary), `vecAvailable` is
// false and vector search falls back to brute-force cosine in JS.
//
// Conventions (matching migrations/*.sql):
//   ids         TEXT uuid, app-generated via uuid()
//   timestamps  TEXT ISO-8601 UTC via nowISO()
//   JSON        TEXT via toJson()/fromJson()
//   booleans    INTEGER 0/1
//   embeddings  BLOB Float32Array bytes via float32ToBuffer()/bufferToFloat32()

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { env } from "@omni/env-config";
import { logger } from "./logging/logger.js";

// ─── Data root ──────────────────────────────────────────────────────

/** Resolved data root. Everything Omni persists lives under here. */
export const DATA_DIR: string = env.OMNI_DATA_DIR
  ? path.resolve(env.OMNI_DATA_DIR)
  : path.join(homedir(), ".omni");

// Blob subdirectories, created eagerly so write paths never have to
// mkdir first: drive/ (uploaded files), artifacts/ (generated blobs),
// runs/ (agent spill + code workspaces).
for (const sub of ["", "drive", "artifacts", "runs"]) {
  mkdirSync(path.join(DATA_DIR, sub), { recursive: true });
}

// ─── Database singleton ─────────────────────────────────────────────

export const db: Database.Database = new Database(
  path.join(DATA_DIR, "omni.db"),
);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");

/** True when the sqlite-vec extension loaded and vec0 tables are usable. */
export let vecAvailable = false;

try {
  sqliteVec.load(db);
  vecAvailable = true;
} catch (err) {
  logger.warn(
    { err },
    "sqlite-vec failed to load — vector search will use the JS cosine fallback",
  );
}

// ─── Prepared-statement cache ───────────────────────────────────────
//
// db.prepare() compiles SQL every call; hot paths (chat persistence, the
// drive indexer tick) reuse identical SQL constantly. Cache by SQL text.

const stmtCache = new Map<string, Database.Statement>();

function prepare(sql: string): Database.Statement {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

// ─── Query helpers ──────────────────────────────────────────────────

/** Run a SELECT expecting at most one row. */
export function one<T>(sql: string, ...params: unknown[]): T | undefined {
  return prepare(sql).get(...params) as T | undefined;
}

/** Run a SELECT returning all rows. */
export function all<T>(sql: string, ...params: unknown[]): T[] {
  return prepare(sql).all(...params) as T[];
}

/** Run an INSERT/UPDATE/DELETE; returns { changes, lastInsertRowid }. */
export function run(sql: string, ...params: unknown[]): Database.RunResult {
  return prepare(sql).run(...params);
}

/**
 * Run `fn` inside an immediate transaction. Nested calls are handled by
 * better-sqlite3 (inner calls become savepoints). Use for any multi-row
 * write so a crash can't leave half a logical operation behind.
 */
export function tx<T>(fn: () => T): T {
  return db.transaction(fn)();
}

// ─── Value helpers ──────────────────────────────────────────────────

/** App-generated TEXT uuid primary key. */
export function uuid(): string {
  return randomUUID();
}

/** ISO-8601 UTC timestamp, e.g. "2026-07-03T12:34:56.789Z". */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Serialize a value for a JSON TEXT column; null/undefined -> SQL NULL. */
export function toJson(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return JSON.stringify(v);
}

/** Parse a JSON TEXT column; null/empty/malformed -> null (never throws). */
export function fromJson<T>(s: string | null | undefined): T | null {
  if (s === null || s === undefined || s === "") return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

// ─── Embedding BLOB helpers ─────────────────────────────────────────
//
// hub_memory_chunks.embedding stores Float32Array bytes; the vec0 index
// is rebuildable from these rows. Round-trip helpers keep byte-order and
// alignment concerns in one place.

/** Pack an embedding into a Buffer of little-endian float32 bytes. */
export function float32ToBuffer(vec: readonly number[] | Float32Array): Buffer {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Unpack a BLOB back into a Float32Array. Copies into a fresh, aligned
 * ArrayBuffer — SQLite BLOBs surface as pooled Buffers whose byteOffset
 * is not guaranteed to be 4-byte aligned for a Float32Array view.
 */
export function bufferToFloat32(buf: Uint8Array): Float32Array {
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

// ─── sqlite-vec index ───────────────────────────────────────────────

/**
 * True when vec_hub_memory was created WITH the `hub_id` partition-key
 * column. Older sqlite-vec builds reject `partition key`; in that case we
 * create the table without it and search code must over-fetch (k*4) and
 * filter by hub in JS instead of pushing the hub filter into the KNN.
 */
export let vecHasPartition = false;

/**
 * Create the vec0 virtual table + cleanup trigger. Called by
 * runMigrations() AFTER the .sql migrations, and deliberately kept in
 * code (not in a migration) so the .sql files still apply cleanly when
 * the sqlite-vec extension fails to load.
 */
export function ensureVecIndex(): void {
  if (!vecAvailable) return;

  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_hub_memory USING vec0(
      hub_id TEXT partition key,
      embedding float[1536] distance_metric=cosine
    )`);
    vecHasPartition = true;
  } catch (err) {
    // Installed sqlite-vec predates partition-key support — fall back to
    // a plain vec0 table. vecHasPartition stays false so callers know to
    // over-fetch + filter.
    logger.warn(
      { err },
      "vec0 partition key unsupported — creating vec_hub_memory without it",
    );
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_hub_memory USING vec0(
      embedding float[1536] distance_metric=cosine
    )`);
    vecHasPartition = false;
  }

  // Keep the index consistent when chunks are deleted (file detach/delete
  // cascades). Inserts are done explicitly by the indexer, which stores
  // lastInsertRowid back on the chunk row as vec_rowid.
  db.exec(`CREATE TRIGGER IF NOT EXISTS hub_memory_chunks_ad
    AFTER DELETE ON hub_memory_chunks
    BEGIN
      DELETE FROM vec_hub_memory WHERE rowid = old.vec_rowid;
    END`);
}
