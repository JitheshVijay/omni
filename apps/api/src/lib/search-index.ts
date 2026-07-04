// Unified semantic index for GLOBAL search — one box that finds across Drive
// files, generated artifacts, chat threads, and hub memory chunks.
//
// The search_items row (title + snippet + embedding BLOB) is the source of
// truth; vec_search_items is a rebuildable vec0 KNN index over the same
// embeddings, created in code (ensureSearchVecIndex) so the .sql migrations
// still apply when sqlite-vec can't load. Search degrades gracefully:
//   1. vec0 KNN (over-fetch k*4, filter by user/kind in the join),
//   2. no sqlite-vec: brute-force cosine over the user's embedded rows,
//   3. no embeddings at all (OpenRouter key unset / down): keyword LIKE
//      over the source tables, flagged mode:'keyword' to the caller.
//
// Mirrors the three-tier posture of lib/hub-memory.ts; embedding cost is kept
// low by deduping on content_hash so reindexAll only (re)embeds changed items.
import { createHash } from "node:crypto";
import {
  all,
  cosine,
  embedText,
  fromJson,
  logger,
  nowISO,
  one,
  run,
  tx,
  uuid,
  vecAvailable,
} from "@omni/sdk";

export type SearchKind = "drive" | "artifact" | "thread" | "hub_chunk";

const SEARCH_KINDS: readonly SearchKind[] = [
  "drive",
  "artifact",
  "thread",
  "hub_chunk",
];

export interface SearchHit {
  kind: SearchKind;
  ref_id: string;
  title: string;
  snippet: string;
  score: number;
  href: string;
}

export interface SearchResponse {
  mode: "semantic" | "keyword";
  results: SearchHit[];
}

// Per-source cap so reindexAll stays bounded regardless of workspace size.
const REINDEX_LIMIT = 300;
// How much artifact/chunk text feeds the snippet + embedding.
const SNIPPET_MAX = 320;
const ARTIFACT_TEXT_BUDGET = 6000;

// ───────── pure helpers (unit-tested; no DB / no live embeddings) ─────────

/** sha256 of the indexed text — the dedupe key for skipping unchanged items. */
export function contentHash(title: string, snippet: string): string {
  return createHash("sha256")
    .update(`${title}\n${snippet}`, "utf8")
    .digest("hex");
}

/** Collapse whitespace and clip to a preview-sized snippet. */
export function makeSnippet(text: string, max = SNIPPET_MAX): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** vec0 returns cosine DISTANCE; map to a similarity score (higher = closer). */
export function scoreFromDistance(distance: number): number {
  return 1 - distance;
}

/** Route a search hit to its in-app destination. Pure — unit-tested. */
export function hrefFor(item: {
  kind: SearchKind;
  ref_id: string;
  artifactKind?: string | null;
  hubId?: string | null;
}): string {
  switch (item.kind) {
    case "drive":
      return "/drive";
    case "thread":
      return `/chat/${item.ref_id}`;
    case "hub_chunk":
      return item.hubId ? `/hubs/${item.hubId}` : "/hubs";
    case "artifact":
      return artifactHref(item.artifactKind, item.ref_id);
    default:
      return "/";
  }
}

function artifactHref(kind: string | null | undefined, id: string): string {
  switch (kind) {
    case "doc":
      return `/tools/docs/${id}`;
    case "slides":
      return `/tools/slides/${id}`;
    case "sheet":
      return `/tools/sheets/${id}`;
    case "image":
      return "/tools/images";
    case "audio":
      return "/tools/podcast";
    default:
      return "/library";
  }
}

/**
 * Flatten a stored artifact `content` JSON (doc markdown, sheet cells, slide
 * titles/bullets, …) into a single searchable string, bounded so a huge deck
 * can't blow the embedding input. Generic recursion handles every kind.
 */
export function extractArtifactText(content: string | null): string {
  const parsed = fromJson<unknown>(content);
  if (parsed == null) return "";
  const out: string[] = [];
  const budget = { n: ARTIFACT_TEXT_BUDGET };
  collectStrings(parsed, out, budget);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function collectStrings(v: unknown, out: string[], budget: { n: number }): void {
  if (budget.n <= 0) return;
  if (typeof v === "string") {
    out.push(v);
    budget.n -= v.length;
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      if (budget.n <= 0) return;
      collectStrings(x, out, budget);
    }
    return;
  }
  if (v && typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) {
      if (budget.n <= 0) return;
      collectStrings(x, out, budget);
    }
  }
}

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

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function normalizeKinds(kinds?: SearchKind[]): SearchKind[] {
  if (!kinds || kinds.length === 0) return [...SEARCH_KINDS];
  const set = new Set(kinds.filter((k) => SEARCH_KINDS.includes(k)));
  return set.size > 0 ? [...set] : [...SEARCH_KINDS];
}

// ───────── vec0 companion index (created in code) ─────────

let searchVecReady = false;

/**
 * Create the vec0 virtual table backing the search index + a cleanup trigger.
 * Mirrors ensureVecIndex in packages/sdk/db.ts. Idempotent; no-op when
 * sqlite-vec is unavailable (search then uses the JS cosine / keyword paths).
 * Safe to call from boot AND lazily on first index.
 */
export function ensureSearchVecIndex(): void {
  if (searchVecReady || !vecAvailable) return;
  try {
    run(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_search_items USING vec0(
      embedding float[1536] distance_metric=cosine
    )`);
    run(`CREATE TRIGGER IF NOT EXISTS search_items_ad
      AFTER DELETE ON search_items
      BEGIN
        DELETE FROM vec_search_items WHERE rowid = old.vec_rowid;
      END`);
    searchVecReady = true;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200) },
      "[search-index] vec0 setup failed — search falls back to JS cosine/keyword",
    );
  }
}

/** Insert one item's embedding into vec_search_items and record its rowid. */
function insertItemEmbedding(itemId: string, embedding: number[]): void {
  if (!vecAvailable) return;
  try {
    const res = run(
      "INSERT INTO vec_search_items (embedding) VALUES (?)",
      embeddingToBuffer(embedding),
    );
    run(
      "UPDATE search_items SET vec_rowid = ? WHERE id = ?",
      Number(res.lastInsertRowid),
      itemId,
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200), itemId },
      "[search-index] vec insert failed; item remains brute-force searchable",
    );
  }
}

// ───────── indexing ─────────

interface ExistingRow {
  content_hash: string;
  embedding: Buffer | null;
}

/**
 * Upsert one item into the index. Embeds title + snippet and stores the row +
 * vec entry. Returns true when a write happened, false when the item was
 * unchanged (same content_hash and already embedded) and skipped.
 *
 * Fail-soft: if embeddings are unavailable the row is still written with a
 * null embedding so keyword search can find it, and a later reindex (once
 * embeddings return) fills it in.
 */
export async function indexItem(input: {
  userId: string;
  kind: SearchKind;
  ref_id: string;
  title: string;
  text: string;
}): Promise<boolean> {
  ensureSearchVecIndex();
  const title = (input.title ?? "").trim();
  const snippet = makeSnippet(input.text ?? "");
  const hash = contentHash(title, snippet);

  const existing = one<ExistingRow>(
    "SELECT content_hash, embedding FROM search_items WHERE kind = ? AND ref_id = ?",
    input.kind,
    input.ref_id,
  );
  // Unchanged AND already embedded — nothing to do. If the prior row had no
  // embedding (embeddings were down), fall through to retry the embed.
  if (existing && existing.content_hash === hash && existing.embedding) {
    return false;
  }

  const embedInput = `${title}\n${snippet}`.trim();
  const embedding = embedInput ? await embedText(embedInput) : null;
  const buf = embedding ? embeddingToBuffer(embedding) : null;
  const id = uuid();

  // INSERT OR REPLACE on UNIQUE(kind, ref_id): the conflicting row is deleted
  // (its AFTER DELETE trigger cleans the stale vec entry) then reinserted, so
  // vec_rowid never dangles. The fresh vec row is inserted right after.
  tx(() => {
    run(
      `INSERT OR REPLACE INTO search_items
         (id, user_id, kind, ref_id, title, snippet, embedding, vec_rowid, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      id,
      input.userId,
      input.kind,
      input.ref_id,
      title,
      snippet,
      buf,
      hash,
      nowISO(),
    );
    if (embedding) insertItemEmbedding(id, embedding);
  });
  return true;
}

/** Remove one item from the index (the AFTER DELETE trigger cleans its vec row). */
export function removeItem(kind: SearchKind, refId: string): void {
  run("DELETE FROM search_items WHERE kind = ? AND ref_id = ?", kind, refId);
}

/**
 * Sweep the workspace and (re)index Drive files, artifacts, and chat threads,
 * bounded to the most-recent REINDEX_LIMIT of each. Dedupes on content_hash so
 * only changed items are re-embedded. hub memory chunks are intentionally NOT
 * bulk-embedded here (a Drive file's own item already represents its content
 * semantically, and the dedicated hub-memory search covers deep chunk KNN);
 * they remain reachable through the keyword fallback. Returns the number of
 * items actually written.
 */
export async function reindexAll(userId: string): Promise<number> {
  ensureSearchVecIndex();
  let indexed = 0;

  const files = all<{ id: string; name: string; chunk_text: string | null }>(
    `SELECT f.id, f.name,
            (SELECT c.chunk_text FROM hub_memory_chunks c
              WHERE c.file_id = f.id ORDER BY c.chunk_idx LIMIT 1) AS chunk_text
       FROM drive_files f
      WHERE f.user_id = ?
      ORDER BY f.created_at DESC
      LIMIT ?`,
    userId,
    REINDEX_LIMIT,
  );
  for (const f of files) {
    if (
      await indexItem({
        userId,
        kind: "drive",
        ref_id: f.id,
        title: f.name,
        text: f.chunk_text ?? "",
      })
    )
      indexed++;
  }

  const artifacts = all<{ id: string; title: string; content: string | null }>(
    `SELECT id, title, content FROM artifacts
      WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    userId,
    REINDEX_LIMIT,
  );
  for (const a of artifacts) {
    if (
      await indexItem({
        userId,
        kind: "artifact",
        ref_id: a.id,
        title: a.title,
        text: extractArtifactText(a.content),
      })
    )
      indexed++;
  }

  const threads = all<{ id: string; title: string; first_msg: string | null }>(
    `SELECT t.id, t.title,
            (SELECT m.content FROM chat_messages m
              WHERE m.thread_id = t.id AND m.role = 'user'
              ORDER BY m.created_at LIMIT 1) AS first_msg
       FROM chat_threads t
      WHERE t.user_id = ?
      ORDER BY t.updated_at DESC
      LIMIT ?`,
    userId,
    REINDEX_LIMIT,
  );
  for (const t of threads) {
    if (
      await indexItem({
        userId,
        kind: "thread",
        ref_id: t.id,
        title: t.title || "Untitled chat",
        text: t.first_msg ?? "",
      })
    )
      indexed++;
  }

  logger.info({ userId, indexed }, "[search-index] reindexAll complete");
  return indexed;
}

// ───────── search ─────────

interface CandidateRow {
  kind: SearchKind;
  ref_id: string;
  title: string;
  snippet: string;
  vec_rowid: number | null;
}

/**
 * Search everything for `query`. Tries semantic KNN first; when embeddings are
 * unavailable (no OpenRouter key / API down) falls back to keyword LIKE over
 * the source tables and flags mode:'keyword'. Never throws — returns an empty
 * result set on total failure.
 */
export async function searchAll(
  userId: string,
  query: string,
  opts: { k?: number; kinds?: SearchKind[] } = {},
): Promise<SearchResponse> {
  const q = (query ?? "").trim();
  const k = Math.min(Math.max(opts.k ?? 20, 1), 50);
  const kinds = normalizeKinds(opts.kinds);
  if (!q) return { mode: "semantic", results: [] };

  const embedding = await embedText(q);
  if (!embedding) {
    return { mode: "keyword", results: keywordSearch(userId, q, k, kinds) };
  }

  try {
    const hits = vecAvailable
      ? vecSearch(userId, embedding, k, kinds)
      : bruteForceSearch(userId, embedding, k, kinds);
    return { mode: "semantic", results: hits };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200) },
      "[search-index] semantic search failed; keyword fallback",
    );
    return { mode: "keyword", results: keywordSearch(userId, q, k, kinds) };
  }
}

function kindFilterSql(kinds: SearchKind[]): { clause: string; params: string[] } {
  if (kinds.length >= SEARCH_KINDS.length) return { clause: "", params: [] };
  const placeholders = kinds.map(() => "?").join(",");
  return { clause: ` AND kind IN (${placeholders})`, params: kinds };
}

function vecSearch(
  userId: string,
  embedding: number[],
  k: number,
  kinds: SearchKind[],
): SearchHit[] {
  const rows = all<{ rowid: number; distance: number }>(
    "SELECT rowid, distance FROM vec_search_items WHERE embedding MATCH ? AND k = ?",
    embeddingToBuffer(embedding),
    k * 4,
  );
  if (rows.length === 0) return [];
  const distanceByRowid = new Map<number, number>();
  for (const r of rows) distanceByRowid.set(Number(r.rowid), r.distance);

  const placeholders = [...distanceByRowid.keys()].map(() => "?").join(",");
  const kindFilter = kindFilterSql(kinds);
  const candidates = all<CandidateRow>(
    `SELECT kind, ref_id, title, snippet, vec_rowid FROM search_items
      WHERE vec_rowid IN (${placeholders}) AND user_id = ?${kindFilter.clause}`,
    ...distanceByRowid.keys(),
    userId,
    ...kindFilter.params,
  );
  return hydrate(
    candidates.map((c) => ({
      row: c,
      score: scoreFromDistance(distanceByRowid.get(Number(c.vec_rowid)) ?? 1),
    })),
  )
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function bruteForceSearch(
  userId: string,
  embedding: number[],
  k: number,
  kinds: SearchKind[],
): SearchHit[] {
  const kindFilter = kindFilterSql(kinds);
  const rows = all<CandidateRow & { embedding: Buffer | null }>(
    `SELECT kind, ref_id, title, snippet, vec_rowid, embedding FROM search_items
      WHERE user_id = ? AND embedding IS NOT NULL${kindFilter.clause}`,
    userId,
    ...kindFilter.params,
  );
  return hydrate(
    rows.map((r) => ({
      row: r,
      score: cosine(embedding, bufferToVector(r.embedding as Buffer)),
    })),
  )
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * Attach href (and drop items whose source row was deleted since indexing) by
 * looking up the routing metadata each kind needs: an artifact's kind, a hub
 * chunk's hub_id. Everything else routes from the search_items row alone.
 */
function hydrate(scored: Array<{ row: CandidateRow; score: number }>): SearchHit[] {
  const out: SearchHit[] = [];
  for (const { row, score } of scored) {
    let artifactKind: string | null | undefined;
    let hubId: string | null | undefined;
    if (row.kind === "artifact") {
      const a = one<{ kind: string }>(
        "SELECT kind FROM artifacts WHERE id = ?",
        row.ref_id,
      );
      if (!a) continue; // deleted since indexed
      artifactKind = a.kind;
    } else if (row.kind === "hub_chunk") {
      const c = one<{ hub_id: string }>(
        "SELECT hub_id FROM hub_memory_chunks WHERE id = ?",
        row.ref_id,
      );
      if (!c) continue;
      hubId = c.hub_id;
    }
    out.push({
      kind: row.kind,
      ref_id: row.ref_id,
      title: row.title,
      snippet: row.snippet,
      score,
      href: hrefFor({ kind: row.kind, ref_id: row.ref_id, artifactKind, hubId }),
    });
  }
  return out;
}

/**
 * Keyword fallback: LIKE over the source tables directly (not search_items),
 * so it works even when the index has never been built. Score is a nominal
 * descending rank within each kind — the UI groups by kind regardless.
 */
export function keywordSearch(
  userId: string,
  query: string,
  k: number,
  kinds: SearchKind[],
): SearchHit[] {
  const like = `%${escapeLike(query)}%`;
  const per = Math.max(3, Math.ceil(k / Math.max(kinds.length, 1)));
  const want = new Set(kinds);
  const hits: SearchHit[] = [];

  if (want.has("drive")) {
    const rows = all<{ id: string; name: string; snippet: string | null }>(
      `SELECT f.id, f.name,
              (SELECT c.chunk_text FROM hub_memory_chunks c
                WHERE c.file_id = f.id ORDER BY c.chunk_idx LIMIT 1) AS snippet
         FROM drive_files f
        WHERE f.user_id = ? AND f.name LIKE ? ESCAPE '\\'
        ORDER BY f.created_at DESC LIMIT ?`,
      userId,
      like,
      per,
    );
    for (const r of rows) {
      hits.push({
        kind: "drive",
        ref_id: r.id,
        title: r.name,
        snippet: makeSnippet(r.snippet ?? ""),
        score: 0.5,
        href: hrefFor({ kind: "drive", ref_id: r.id }),
      });
    }
  }

  if (want.has("artifact")) {
    const rows = all<{
      id: string;
      kind: string;
      title: string;
      content: string | null;
    }>(
      `SELECT id, kind, title, content FROM artifacts
        WHERE user_id = ? AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
        ORDER BY created_at DESC LIMIT ?`,
      userId,
      like,
      like,
      per,
    );
    for (const r of rows) {
      hits.push({
        kind: "artifact",
        ref_id: r.id,
        title: r.title,
        snippet: makeSnippet(extractArtifactText(r.content)),
        score: 0.5,
        href: hrefFor({ kind: "artifact", ref_id: r.id, artifactKind: r.kind }),
      });
    }
  }

  if (want.has("thread")) {
    const rows = all<{ id: string; title: string; snippet: string | null }>(
      `SELECT t.id, t.title,
              (SELECT m.content FROM chat_messages m
                WHERE m.thread_id = t.id AND m.role = 'user'
                ORDER BY m.created_at LIMIT 1) AS snippet
         FROM chat_threads t
        WHERE t.user_id = ? AND t.title LIKE ? ESCAPE '\\'
        ORDER BY t.updated_at DESC LIMIT ?`,
      userId,
      like,
      per,
    );
    for (const r of rows) {
      hits.push({
        kind: "thread",
        ref_id: r.id,
        title: r.title || "Untitled chat",
        snippet: makeSnippet(r.snippet ?? ""),
        score: 0.5,
        href: hrefFor({ kind: "thread", ref_id: r.id }),
      });
    }
  }

  if (want.has("hub_chunk")) {
    const rows = all<{
      id: string;
      hub_id: string;
      chunk_text: string;
      file_name: string | null;
    }>(
      `SELECT c.id, c.hub_id, c.chunk_text, f.name AS file_name
         FROM hub_memory_chunks c
         LEFT JOIN drive_files f ON f.id = c.file_id
        WHERE c.user_id = ? AND c.chunk_text LIKE ? ESCAPE '\\'
        ORDER BY c.created_at DESC LIMIT ?`,
      userId,
      like,
      per,
    );
    for (const r of rows) {
      hits.push({
        kind: "hub_chunk",
        ref_id: r.id,
        title: r.file_name ?? "Hub memory",
        snippet: makeSnippet(r.chunk_text),
        score: 0.5,
        href: hrefFor({ kind: "hub_chunk", ref_id: r.id, hubId: r.hub_id }),
      });
    }
  }

  return hits.slice(0, k);
}
