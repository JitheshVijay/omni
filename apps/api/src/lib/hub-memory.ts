// Hub memory vector search over hub_memory_chunks.
//
// The embedding BLOB on the chunk row is the source of truth; the vec0
// virtual table (vec_hub_memory, created by ensureVecIndex when sqlite-vec
// loads) is a rebuildable KNN index. Three tiers, degrading gracefully:
//   1. vec0 KNN with the hub_id partition key (fastest),
//   2. vec0 KNN without partition support: over-fetch k*4, filter in JS,
//   3. no sqlite-vec at all: brute-force cosine over hub-scoped chunks.
import { all, cosine, one, run, vecAvailable, logger } from "@omni/sdk";

export interface HubMemoryHit {
  chunk_id: string;
  file_id: string | null;
  file_name: string | null;
  cite_label: string;
  section_title: string | null;
  chunk_text: string;
  score: number;
}

interface ChunkRow {
  id: string;
  file_id: string | null;
  file_name: string | null;
  cite_label: string;
  section_title: string | null;
  chunk_text: string;
  vec_rowid: number | null;
}

// Whether the installed sqlite-vec build supports `hub_id TEXT partition key`
// on vec0 tables. Detected lazily on first error; undefined = untested.
let partitionSupported: boolean | undefined;

function embeddingToBuffer(embedding: number[]): Buffer {
  return Buffer.from(Float32Array.from(embedding).buffer);
}

function bufferToVector(blob: Buffer): number[] {
  const f32 = new Float32Array(
    blob.buffer,
    blob.byteOffset,
    Math.floor(blob.byteLength / 4),
  );
  return Array.from(f32);
}

function chunksByVecRowids(rowids: number[], hubId?: string): ChunkRow[] {
  if (rowids.length === 0) return [];
  const placeholders = rowids.map(() => "?").join(",");
  const hubFilter = hubId ? " AND c.hub_id = ?" : "";
  const params: unknown[] = [...rowids];
  if (hubId) params.push(hubId);
  return all<ChunkRow>(
    `SELECT c.id, c.file_id, f.name AS file_name, c.cite_label, c.section_title,
            c.chunk_text, c.vec_rowid
       FROM hub_memory_chunks c
       LEFT JOIN drive_files f ON f.id = c.file_id
      WHERE c.vec_rowid IN (${placeholders})${hubFilter}`,
    ...params,
  );
}

/**
 * KNN search over one hub's memory. Returns up to k hits scored 1 - cosine
 * distance (higher = closer), best first. Never throws — falls back through
 * the tiers and returns [] on total failure.
 */
export function searchHubMemory(
  hubId: string,
  queryEmbedding: number[],
  k = 8,
): HubMemoryHit[] {
  if (queryEmbedding.length === 0) return [];

  if (vecAvailable) {
    const qbuf = embeddingToBuffer(queryEmbedding);

    // Tier 1: partition-key KNN.
    if (partitionSupported !== false) {
      try {
        const rows = all<{ rowid: number; distance: number }>(
          `SELECT rowid, distance FROM vec_hub_memory
            WHERE embedding MATCH ? AND hub_id = ? AND k = ?`,
          qbuf,
          hubId,
          k,
        );
        partitionSupported = true;
        return joinHits(rows, hubId).slice(0, k);
      } catch (err) {
        partitionSupported = false;
        logger.warn(
          { err: (err as Error).message?.slice(0, 200) },
          "[hub-memory] partitioned KNN unsupported; over-fetch fallback",
        );
      }
    }

    // Tier 2: unpartitioned KNN — over-fetch and filter by hub in the join.
    try {
      const rows = all<{ rowid: number; distance: number }>(
        `SELECT rowid, distance FROM vec_hub_memory
          WHERE embedding MATCH ? AND k = ?`,
        qbuf,
        k * 4,
      );
      return joinHits(rows, hubId).slice(0, k);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message?.slice(0, 200) },
        "[hub-memory] vec KNN failed; brute-force fallback",
      );
    }
  }

  // Tier 3: brute-force cosine over the hub's chunks in JS.
  return bruteForceSearch(hubId, queryEmbedding, k);
}

function joinHits(
  rows: Array<{ rowid: number; distance: number }>,
  hubId: string,
): HubMemoryHit[] {
  const distanceByRowid = new Map<number, number>();
  for (const r of rows) distanceByRowid.set(Number(r.rowid), r.distance);
  const chunks = chunksByVecRowids([...distanceByRowid.keys()], hubId);
  return chunks
    .map((c) => ({
      chunk_id: c.id,
      file_id: c.file_id,
      file_name: c.file_name,
      cite_label: c.cite_label,
      section_title: c.section_title,
      chunk_text: c.chunk_text,
      score: 1 - (distanceByRowid.get(Number(c.vec_rowid)) ?? 1),
    }))
    .sort((a, b) => b.score - a.score);
}

function bruteForceSearch(
  hubId: string,
  queryEmbedding: number[],
  k: number,
): HubMemoryHit[] {
  try {
    const rows = all<ChunkRow & { embedding: Buffer | null }>(
      `SELECT c.id, c.file_id, f.name AS file_name, c.cite_label, c.section_title,
              c.chunk_text, c.vec_rowid, c.embedding
         FROM hub_memory_chunks c
         LEFT JOIN drive_files f ON f.id = c.file_id
        WHERE c.hub_id = ? AND c.embedding IS NOT NULL`,
      hubId,
    );
    return rows
      .map((r) => ({
        chunk_id: r.id,
        file_id: r.file_id,
        file_name: r.file_name,
        cite_label: r.cite_label,
        section_title: r.section_title,
        chunk_text: r.chunk_text,
        score: cosine(queryEmbedding, bufferToVector(r.embedding as Buffer)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200) },
      "[hub-memory] brute-force search failed",
    );
    return [];
  }
}

/**
 * Insert one chunk's embedding into the vec0 index and record the resulting
 * rowid on the chunk row. No-op when sqlite-vec isn't loaded. Fail-soft: a
 * vec insert failure leaves vec_rowid NULL (brute-force still finds the
 * chunk via its embedding BLOB).
 */
export function insertChunkEmbedding(
  chunkId: string,
  hubId: string,
  embedding: number[],
): void {
  if (!vecAvailable) return;
  const buf = embeddingToBuffer(embedding);
  try {
    let vecRowid: number | bigint;
    if (partitionSupported !== false) {
      try {
        const res = run(
          "INSERT INTO vec_hub_memory (hub_id, embedding) VALUES (?, ?)",
          hubId,
          buf,
        );
        partitionSupported = true;
        vecRowid = res.lastInsertRowid;
      } catch {
        partitionSupported = false;
        const res = run("INSERT INTO vec_hub_memory (embedding) VALUES (?)", buf);
        vecRowid = res.lastInsertRowid;
      }
    } else {
      const res = run("INSERT INTO vec_hub_memory (embedding) VALUES (?)", buf);
      vecRowid = res.lastInsertRowid;
    }
    run(
      "UPDATE hub_memory_chunks SET vec_rowid = ? WHERE id = ?",
      Number(vecRowid),
      chunkId,
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200), chunkId },
      "[hub-memory] vec insert failed; chunk remains brute-force searchable",
    );
  }
}

/** Distinct file ids that already have chunks indexed for the given hub. */
export function indexedHubFileIds(hubId: string): string[] {
  const rows = all<{ file_id: string }>(
    `SELECT DISTINCT file_id FROM hub_memory_chunks
      WHERE hub_id = ? AND file_id IS NOT NULL`,
    hubId,
  );
  return rows.map((r) => r.file_id);
}

/** True when the (hub, file) pair already has at least one chunk. */
export function hubFileIsIndexed(hubId: string, fileId: string): boolean {
  const row = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM hub_memory_chunks WHERE hub_id = ? AND file_id = ?",
    hubId,
    fileId,
  );
  return (row?.n ?? 0) > 0;
}

/**
 * Delete one hub's chunks for a file (detach path). The AFTER DELETE trigger
 * created by ensureVecIndex cleans matching vec rows; the explicit vec delete
 * here is belt-and-braces for databases where the trigger predates the index.
 */
export function deleteChunksForHubFile(hubId: string, fileId: string): void {
  if (vecAvailable) {
    try {
      run(
        `DELETE FROM vec_hub_memory WHERE rowid IN (
           SELECT vec_rowid FROM hub_memory_chunks
            WHERE hub_id = ? AND file_id = ? AND vec_rowid IS NOT NULL)`,
        hubId,
        fileId,
      );
    } catch {
      /* trigger handles it / vec table absent */
    }
  }
  run(
    "DELETE FROM hub_memory_chunks WHERE hub_id = ? AND file_id = ?",
    hubId,
    fileId,
  );
}
