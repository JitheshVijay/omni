// Generator service layer — shared types + artifact row helpers.
//
// Every generator (doc, image, tts, later slides/sheets/podcast) implements
// GeneratorService: one Zod inputSchema as the single source of truth, a
// run() that emits status/delta events itself and resolves to the created
// artifact, and an optional revise() that produces a NEW artifact with
// parent_id lineage. Two adapters share these implementations: the SSE
// route POST /api/generate/:name (P2) and the agent tool auto-wrapper (P3).
import type { z } from "zod";
import { fromJson, nowISO, one, run, uuid } from "@omni/sdk";

/** What list endpoints and SSE artifact events carry — never the content. */
export interface ArtifactSummary {
  id: string;
  kind: string;
  title: string;
  rel_path: string | null;
  parent_id: string | null;
  hub_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

/** Raw artifacts table row (see migrations/003_agent_and_artifacts.sql). */
export interface ArtifactRow {
  id: string;
  user_id: string;
  run_id: string | null;
  thread_id: string | null;
  hub_id: string | null;
  kind: string;
  title: string;
  content: string | null;
  rel_path: string | null;
  drive_file_id: string | null;
  parent_id: string | null;
  meta: string | null;
  created_at: string;
}

export type GenEvent =
  | { type: "status"; label: string }
  | { type: "delta"; channel: string; data: unknown }
  | { type: "artifact"; artifact: ArtifactSummary };

export interface GenCtx {
  userId: string;
  /** Aborts when the SSE client disconnects (or the agent run is cancelled). */
  signal: AbortSignal;
  emit: (e: GenEvent) => void;
}

export interface GeneratorService<I> {
  name: string;
  /** Single source of truth for input validation (route + agent adapter). */
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  /** One-liner used when the generator is exposed as an agent tool (P3). */
  toolDescription: string;
  /** Emits status/delta itself; resolves to the created artifact. */
  run(input: I, ctx: GenCtx): Promise<ArtifactSummary>;
  /** Uniform "edit with AI": new artifact with parent_id = artifactId. */
  revise?(artifactId: string, instruction: string, ctx: GenCtx): Promise<ArtifactSummary>;
}

export function toArtifactSummary(row: ArtifactRow): ArtifactSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    rel_path: row.rel_path,
    parent_id: row.parent_id,
    hub_id: row.hub_id,
    meta: fromJson<Record<string, unknown>>(row.meta),
    created_at: row.created_at,
  };
}

/** Load one artifact scoped to its owner. */
export function getArtifact(id: string, userId: string): ArtifactRow | undefined {
  return one<ArtifactRow>(
    "SELECT * FROM artifacts WHERE id = ? AND user_id = ?",
    id,
    userId,
  );
}

/**
 * Insert an artifact row and return it. Pass `id` when the blob was written
 * first and its filename embeds the id (artifacts/<id>.png).
 */
export function insertArtifact(opts: {
  id?: string;
  userId: string;
  kind: string;
  title: string;
  content?: unknown;
  relPath?: string | null;
  hubId?: string | null;
  parentId?: string | null;
  meta?: unknown;
}): ArtifactRow {
  const id = opts.id ?? uuid();
  run(
    `INSERT INTO artifacts (id, user_id, hub_id, kind, title, content, rel_path, parent_id, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    opts.userId,
    opts.hubId ?? null,
    opts.kind,
    opts.title,
    opts.content === undefined || opts.content === null
      ? null
      : JSON.stringify(opts.content),
    opts.relPath ?? null,
    opts.parentId ?? null,
    opts.meta === undefined || opts.meta === null ? null : JSON.stringify(opts.meta),
    nowISO(),
  );
  return one<ArtifactRow>("SELECT * FROM artifacts WHERE id = ?", id) as ArtifactRow;
}
