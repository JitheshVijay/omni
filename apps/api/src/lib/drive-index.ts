// Background Drive ingestion loop (single-process, claimed_at-only variant of
// Flo101's lesson-recovery worker-tick skeleton).
//
// Pipeline per file: pending -> extracting -> embedding -> ready | failed |
// skipped. Every 15s the tick claims up to 2 claimable rows (pending, or
// stuck in extracting/embedding with a claim older than 5 minutes), extracts
// text, chunks it, embeds in batches, and writes hub_memory_chunks + vec rows
// for EVERY hub the file is attached to. Files attached to no hub still reach
// `ready` — their chunks are written later by indexFileForHub on attach.
import { join } from "node:path";
import {
  DATA_DIR,
  all,
  one,
  run,
  tx,
  uuid,
  nowISO,
  embedText,
  logger,
} from "@omni/sdk";
import { extractText } from "./extract-text.js";
import { chunkText, type TextChunk } from "./chunker.js";
import { hubFileIsIndexed, insertChunkEmbedding } from "./hub-memory.js";

const POLL_INTERVAL_MS = 15_000;
const STALE_CLAIM_MS = 5 * 60 * 1000;
const BATCH_PER_TICK = 2;
const EMBED_BATCH_SIZE = 16;

export interface DriveFileRow {
  id: string;
  user_id: string;
  name: string;
  mime: string;
  size_bytes: number;
  rel_path: string;
  origin: string;
  index_status: string;
  index_error: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EmbeddedChunk {
  chunk: TextChunk;
  embedding: number[];
}

// ───────── status helpers ─────────

function setStatus(fileId: string, status: string): void {
  run(
    "UPDATE drive_files SET index_status = ?, updated_at = ? WHERE id = ?",
    status,
    nowISO(),
    fileId,
  );
}

/** Terminal transition: sets status, records/clears the error, releases the claim. */
function finish(fileId: string, status: "ready" | "failed" | "skipped", error?: string): void {
  run(
    `UPDATE drive_files
        SET index_status = ?, index_error = ?, claimed_at = NULL, updated_at = ?
      WHERE id = ?`,
    status,
    error ? error.slice(0, 500) : null,
    nowISO(),
    fileId,
  );
}

// ───────── embedding + chunk writes ─────────

async function embedChunks(chunks: TextChunk[]): Promise<EmbeddedChunk[]> {
  const out: EmbeddedChunk[] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await Promise.all(batch.map((c) => embedText(c.chunk_text)));
    for (let j = 0; j < batch.length; j++) {
      const embedding = embeddings[j];
      // Skip chunks whose embedding failed — the rest of the file still indexes.
      if (embedding) out.push({ chunk: batch[j], embedding });
    }
  }
  return out;
}

/**
 * Write one hub's chunk rows + vec index entries for a file, in transactions
 * per batch. INSERT OR REPLACE keyed on UNIQUE(hub_id, file_id, chunk_idx)
 * gives upsert semantics (the replaced row's AFTER DELETE trigger cleans its
 * old vec entry).
 */
function writeChunksForHub(
  file: Pick<DriveFileRow, "id" | "user_id">,
  hubId: string,
  embedded: EmbeddedChunk[],
): void {
  for (let i = 0; i < embedded.length; i += EMBED_BATCH_SIZE) {
    const batch = embedded.slice(i, i + EMBED_BATCH_SIZE);
    tx(() => {
      for (const { chunk, embedding } of batch) {
        const chunkId = uuid();
        run(
          `INSERT OR REPLACE INTO hub_memory_chunks
             (id, user_id, hub_id, file_id, kind, chunk_idx, chunk_text,
              cite_label, section_title, embedding, content_hash)
           VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, ?)`,
          chunkId,
          file.user_id,
          hubId,
          file.id,
          chunk.chunk_idx,
          chunk.chunk_text,
          chunk.cite_label,
          chunk.section_title ?? null,
          Buffer.from(Float32Array.from(embedding).buffer),
          chunk.content_hash,
        );
        insertChunkEmbedding(chunkId, hubId, embedding);
      }
    });
  }
}

function attachedHubIds(fileId: string): string[] {
  return all<{ hub_id: string }>(
    "SELECT hub_id FROM hub_files WHERE file_id = ?",
    fileId,
  ).map((r) => r.hub_id);
}

// ───────── per-file pipeline ─────────

async function processFile(file: DriveFileRow): Promise<void> {
  const log = logger.child({ fileId: file.id, name: file.name });
  try {
    setStatus(file.id, "extracting");
    const extracted = await extractText(
      join(DATA_DIR, file.rel_path),
      file.mime,
      file.name,
    );
    if (extracted === null) {
      finish(file.id, "skipped", "unsupported file type (no text extractor)");
      log.info("[drive-index] skipped (unsupported type)");
      return;
    }

    const chunks = chunkText(extracted);
    if (chunks.length === 0) {
      finish(file.id, "skipped", "no text extracted");
      log.info("[drive-index] skipped (no text)");
      return;
    }

    setStatus(file.id, "embedding");
    const hubIds = attachedHubIds(file.id);
    if (hubIds.length === 0) {
      // Not attached anywhere yet — nothing to write. Chunks are produced on
      // demand by indexFileForHub when the file is attached to a hub.
      finish(file.id, "ready");
      log.info({ chunks: chunks.length }, "[drive-index] ready (no hubs attached)");
      return;
    }

    const embedded = await embedChunks(chunks);
    if (embedded.length === 0) {
      finish(file.id, "failed", "embedding unavailable (no chunks embedded)");
      log.warn("[drive-index] failed — embedding unavailable");
      return;
    }

    for (const hubId of hubIds) {
      writeChunksForHub(file, hubId, embedded);
    }
    finish(file.id, "ready");
    log.info(
      { chunks: embedded.length, hubs: hubIds.length },
      "[drive-index] ready",
    );
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    finish(file.id, "failed", message);
    log.warn({ err: message.slice(0, 300) }, "[drive-index] failed");
  }
}

/**
 * Index one file into one hub, re-extracting from the blob. Used when
 * attaching an already-`ready` file to a new hub (the background loop only
 * writes chunks for hubs attached at index time). No-op when the (hub, file)
 * pair already has chunks. Never flips the file's global index_status.
 */
export async function indexFileForHub(fileId: string, hubId: string): Promise<void> {
  const log = logger.child({ fileId, hubId });
  try {
    if (hubFileIsIndexed(hubId, fileId)) return;
    const file = one<DriveFileRow>(
      "SELECT * FROM drive_files WHERE id = ?",
      fileId,
    );
    if (!file) return;

    const extracted = await extractText(
      join(DATA_DIR, file.rel_path),
      file.mime,
      file.name,
    );
    if (extracted === null) return;
    const chunks = chunkText(extracted);
    if (chunks.length === 0) return;

    const embedded = await embedChunks(chunks);
    if (embedded.length === 0) {
      log.warn("[drive-index] attach-index failed — embedding unavailable");
      return;
    }
    writeChunksForHub(file, hubId, embedded);
    log.info({ chunks: embedded.length }, "[drive-index] attach-indexed");
  } catch (err) {
    log.warn(
      { err: (err as Error).message?.slice(0, 300) ?? String(err) },
      "[drive-index] attach-index threw",
    );
  }
}

// ───────── the loop ─────────

function claimFile(fileId: string): boolean {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const res = run(
    `UPDATE drive_files SET claimed_at = ?
      WHERE id = ? AND (claimed_at IS NULL OR claimed_at < ?)`,
    nowISO(),
    fileId,
    cutoff,
  );
  return res.changes === 1;
}

async function tick(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const candidates = all<DriveFileRow>(
    `SELECT * FROM drive_files
      WHERE (index_status = 'pending' AND (claimed_at IS NULL OR claimed_at < ?))
         OR (index_status IN ('extracting','embedding')
             AND claimed_at IS NOT NULL AND claimed_at < ?)
      ORDER BY created_at ASC
      LIMIT ?`,
    cutoff,
    cutoff,
    BATCH_PER_TICK,
  );
  for (const file of candidates) {
    if (!claimFile(file.id)) continue;
    // Sequential per tick — extraction + embedding are heavy enough that
    // parallel files just contend on the same OpenRouter budget.
    await processFile(file);
  }
}

let started = false;

/**
 * Start the ingestion loop. Idempotent. On boot, rows stranded mid-pipeline
 * by a previous process (extracting/embedding) are reset to pending so they
 * are re-picked immediately rather than after the 5-minute stale window.
 */
export function startDriveIndexLoop(): void {
  if (started) return;
  started = true;

  const reset = run(
    `UPDATE drive_files SET index_status = 'pending', claimed_at = NULL
      WHERE index_status IN ('extracting','embedding')`,
  );
  if (reset.changes > 0) {
    logger.info({ reset: reset.changes }, "[drive-index] reset stuck rows to pending");
  }
  logger.info({ pollMs: POLL_INTERVAL_MS }, "[drive-index] starting ingestion loop");

  let ticking = false;
  const safeTick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await tick();
    } catch (err) {
      logger.warn(
        { err: (err as Error).message?.slice(0, 300) ?? String(err) },
        "[drive-index] tick threw",
      );
    } finally {
      ticking = false;
    }
  };

  void safeTick();
  const timer = setInterval(() => void safeTick(), POLL_INTERVAL_MS);
  // Don't keep the event loop alive purely for this timer.
  timer.unref?.();
}
