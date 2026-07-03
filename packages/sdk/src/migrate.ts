// Migration runner. API boot calls runMigrations() before listen; the
// standalone scripts/migrate.ts wraps it for `npm run db:migrate`.
//
// Applies migrations/*.sql in lexical order, each inside a transaction,
// recording applied files in _migrations. The migrations directory is
// found by walking up from cwd (same trick env-config uses for .env) so
// the runner works from the repo root, apps/api, or a package dir.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { db, ensureVecIndex, nowISO } from "./db.js";
import { logger } from "./logging/logger.js";

function findMigrationsDir(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.resolve(dir, "migrations");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    dir = path.resolve(dir, "..");
  }
  return undefined;
}

/**
 * Apply all unapplied migrations, then ensure the sqlite-vec index
 * exists. Returns the filenames applied in this call (empty array when
 * the database was already up to date).
 */
export function runMigrations(): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const dir = findMigrationsDir();
  if (!dir) {
    throw new Error(
      "runMigrations: could not find a migrations/ directory walking up from " +
        process.cwd(),
    );
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const isApplied = db.prepare(
    "SELECT 1 FROM _migrations WHERE filename = ?",
  );
  const markApplied = db.prepare(
    "INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)",
  );

  const applied: string[] = [];
  for (const filename of files) {
    if (isApplied.get(filename)) continue;
    const sql = readFileSync(path.join(dir, filename), "utf8");
    db.transaction(() => {
      db.exec(sql);
      markApplied.run(filename, nowISO());
    })();
    applied.push(filename);
    logger.info({ filename }, "applied migration");
  }

  // The vec0 virtual table + trigger live in code (not .sql) so the
  // migrations above apply even when the sqlite-vec extension is absent.
  ensureVecIndex();

  return applied;
}
