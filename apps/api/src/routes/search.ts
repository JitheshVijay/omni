// Global search API. One box, four sources (Drive files, artifacts, chat
// threads, hub memory) over the unified index in lib/search-index.ts.
//
//   GET  /api/search?q=&kinds=&k=   -> { results, mode }
//   POST /api/search/reindex        -> { started: true }  (fire-and-forget)
//
// Fail-soft throughout: when embeddings are unavailable the GET degrades to a
// keyword LIKE scan and reports mode:'keyword' so the UI can say so.
import type { FastifyInstance } from "fastify";
import { logger } from "@omni/sdk";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  reindexAll,
  searchAll,
  type SearchKind,
} from "../lib/search-index.js";

const VALID_KINDS: readonly SearchKind[] = [
  "drive",
  "artifact",
  "thread",
  "hub_chunk",
];

function parseKinds(raw: string | undefined): SearchKind[] | undefined {
  if (!raw) return undefined;
  const kinds = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SearchKind => VALID_KINDS.includes(s as SearchKind));
  return kinds.length > 0 ? kinds : undefined;
}

function parseK(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return 20;
  return Math.min(Math.max(n, 1), 50);
}

export async function searchRoutes(app: FastifyInstance) {
  // ── GET /api/search ──
  app.get("/api/search", async (request) => {
    const { userId } = request as AuthenticatedRequest;
    const query = request.query as { q?: string; kinds?: string; k?: string };
    const q = (query.q ?? "").trim();
    if (!q) {
      return { success: true, data: { results: [], mode: "semantic" } };
    }
    const { results, mode } = await searchAll(userId, q, {
      k: parseK(query.k),
      kinds: parseKinds(query.kinds),
    });
    return { success: true, data: { results, mode } };
  });

  // ── POST /api/search/reindex (fire-and-forget) ──
  app.post("/api/search/reindex", async (request) => {
    const { userId } = request as AuthenticatedRequest;
    // Don't block the request on the (potentially many-embedding) sweep; a
    // stray rejection here must never take the process down.
    void reindexAll(userId).catch((err) => {
      logger.warn(
        { err: (err as Error).message?.slice(0, 200), userId },
        "[search] reindex failed",
      );
    });
    return { success: true, data: { started: true } };
  });
}
