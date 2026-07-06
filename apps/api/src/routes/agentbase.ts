// AgentBase REST — "Dashboards & CRM". Systems are LLM- or template-generated
// workspaces of typed TABLES + aggregate DASHBOARD TILES.
//
//   GET    /api/agentbase/systems                                  — list (named key)
//   GET    /api/agentbase/systems/:id                              — flat detail
//                                                                     (tables+records+computed tiles)
//   POST   /api/agentbase/systems                                  — create from
//                                                                     {prompt} (LLM) or {from_template}
//   DELETE /api/agentbase/systems/:id                              — delete (cascades)
//   POST   /api/agentbase/systems/:id/tables/:tableId/records      — add a row (bare record)
//   PATCH  /api/agentbase/systems/:id/records/:recordId            — edit a row
//   DELETE /api/agentbase/systems/:id/records/:recordId            — delete a row
//   GET    /api/agentbase/templates                                — gallery (named key)
//
// Envelope conventions mirror routes/skills.ts / routes/workflows.ts:
// named-key LIST, bare CREATE, flat DETAIL, zod safeParse -> 400. Tile values
// are computed server-side in the detail response so the frontend renders
// render-ready numbers. Cascade deletes rely on the FK ON DELETE CASCADE in
// migration 008 (foreign_keys pragma is ON).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, one, run as dbRun, toJson, uuid } from "@omni/sdk";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  AGENTBASE_CATEGORIES,
  AGENTBASE_TEMPLATES,
  getTemplate,
  type TemplateColumn,
} from "../lib/agentbase-templates.js";
import {
  cloneTemplate,
  computeSystemTiles,
  generateSystem,
  touchSystem,
} from "../lib/agentbase-gen.js";

interface SystemRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  accent: string;
  created_at: string;
  updated_at: string;
}

interface TableRow {
  id: string;
  system_id: string;
  user_id: string;
  name: string;
  columns: string;
  position: number;
  created_at: string;
}

interface RecordRow {
  id: string;
  table_id: string;
  system_id: string;
  user_id: string;
  data: string;
  created_at: string;
  updated_at: string;
}

function loadOwnedSystem(id: string, userId: string): SystemRow | undefined {
  return one<SystemRow>("SELECT * FROM systems WHERE id = ? AND user_id = ?", id, userId);
}

function parseColumns(raw: string): TemplateColumn[] {
  try {
    const cols = JSON.parse(raw);
    return Array.isArray(cols) ? (cols as TemplateColumn[]) : [];
  } catch {
    return [];
  }
}

function parseData(raw: string): Record<string, string | number> {
  try {
    const d = JSON.parse(raw);
    return d && typeof d === "object" ? (d as Record<string, string | number>) : {};
  } catch {
    return {};
  }
}

// Count-only summary a system-list card can show without loading everything.
function summarizeSystem(row: SystemRow) {
  const tableCount = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM system_tables WHERE system_id = ?",
    row.id,
  );
  const recordCount = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM system_records WHERE system_id = ?",
    row.id,
  );
  return {
    ...row,
    table_count: tableCount?.n ?? 0,
    record_count: recordCount?.n ?? 0,
  };
}

const CreateSchema = z
  .object({
    prompt: z.string().min(1).max(4000).optional(),
    from_template: z.string().min(1).max(120).optional(),
  })
  .refine((v) => !!v.prompt || !!v.from_template, {
    message: "Provide either a prompt or a from_template id.",
  });

// A record's data is an arbitrary flat object of string|number values keyed by
// column key. Validated shallowly here; the column schema governs meaning.
const RecordDataSchema = z.record(
  z.string(),
  z.union([z.string().max(2000), z.number(), z.null()]),
);

export async function agentbaseRoutes(app: FastifyInstance) {
  // ── GET /api/agentbase/templates ──
  app.get("/api/agentbase/templates", async () => {
    // Ship the gallery blueprints plus a light record count for the preview.
    const templates = AGENTBASE_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      icon: t.icon,
      accent: t.accent,
      tables: t.tables.map((tb) => ({
        name: tb.name,
        columns: tb.columns,
        row_count: tb.sampleRows.length,
      })),
      tiles: t.tiles,
    }));
    return {
      success: true,
      data: { templates, categories: AGENTBASE_CATEGORIES },
    };
  });

  // ── GET /api/agentbase/systems ── list (named key)
  app.get("/api/agentbase/systems", async (request) => {
    const { userId } = request as AuthenticatedRequest;
    const rows = all<SystemRow>(
      "SELECT * FROM systems WHERE user_id = ? ORDER BY updated_at DESC",
      userId,
    );
    return { success: true, data: { systems: rows.map(summarizeSystem) } };
  });

  // ── GET /api/agentbase/systems/:id ── flat detail
  app.get("/api/agentbase/systems/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const system = loadOwnedSystem(id, userId);
    if (!system) {
      return reply
        .status(404)
        .send({ success: false, error: "System not found", code: "not_found" });
    }

    const tableRows = all<TableRow>(
      "SELECT * FROM system_tables WHERE system_id = ? ORDER BY position ASC",
      id,
    );
    const tables = tableRows.map((t) => {
      const records = all<RecordRow>(
        "SELECT * FROM system_records WHERE table_id = ? ORDER BY created_at ASC",
        t.id,
      ).map((r) => ({
        id: r.id,
        table_id: r.table_id,
        data: parseData(r.data),
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
      return {
        id: t.id,
        name: t.name,
        columns: parseColumns(t.columns),
        position: t.position,
        records,
      };
    });

    const tiles = computeSystemTiles(id);

    return { success: true, data: { ...system, tables, tiles } };
  });

  // ── POST /api/agentbase/systems ── create (LLM prompt OR template clone)
  app.post("/api/agentbase/systems", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const parsed = CreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const { prompt, from_template } = parsed.data;

    let systemId: string;
    try {
      if (from_template) {
        const template = getTemplate(from_template);
        if (!template) {
          return reply.status(404).send({
            success: false,
            error: "Template not found",
            code: "template_not_found",
          });
        }
        systemId = cloneTemplate(userId, template);
      } else {
        systemId = await generateSystem(userId, prompt!);
      }
    } catch (err) {
      request.log.error({ err }, "agentbase: failed to create system");
      return reply.status(502).send({
        success: false,
        error: err instanceof Error ? err.message : "Could not create that system.",
        code: "generation_failed",
      });
    }

    const row = loadOwnedSystem(systemId, userId)!;
    return reply.status(201).send({ success: true, data: summarizeSystem(row) });
  });

  // ── DELETE /api/agentbase/systems/:id ── cascades tables/records/tiles
  app.delete("/api/agentbase/systems/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const system = loadOwnedSystem(id, userId);
    if (!system) {
      return reply
        .status(404)
        .send({ success: false, error: "System not found", code: "not_found" });
    }
    dbRun("DELETE FROM systems WHERE id = ?", id);
    return { success: true, data: { deleted: true } };
  });

  // ── POST /api/agentbase/systems/:id/tables/:tableId/records ── add a row
  app.post("/api/agentbase/systems/:id/tables/:tableId/records", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id, tableId } = request.params as { id: string; tableId: string };
    const system = loadOwnedSystem(id, userId);
    if (!system) {
      return reply
        .status(404)
        .send({ success: false, error: "System not found", code: "not_found" });
    }
    const table = one<TableRow>(
      "SELECT * FROM system_tables WHERE id = ? AND system_id = ?",
      tableId,
      id,
    );
    if (!table) {
      return reply
        .status(404)
        .send({ success: false, error: "Table not found", code: "table_not_found" });
    }
    const body = (request.body ?? {}) as { data?: unknown };
    const parsed = RecordDataSchema.safeParse(body.data ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }

    // Keep only known columns, coercing numeric-typed cells to real numbers.
    const columns = parseColumns(table.columns);
    const clean: Record<string, string | number> = {};
    for (const col of columns) {
      const v = parsed.data[col.key];
      if (v === undefined || v === null || v === "") continue;
      if (col.type === "number" || col.type === "currency") {
        const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
        clean[col.key] = Number.isFinite(n) ? n : 0;
      } else {
        clean[col.key] = String(v).slice(0, 2000);
      }
    }

    const recordId = uuid();
    dbRun(
      `INSERT INTO system_records (id, table_id, system_id, user_id, data)
       VALUES (?, ?, ?, ?, ?)`,
      recordId,
      tableId,
      id,
      userId,
      toJson(clean),
    );
    touchSystem(id);
    const row = one<RecordRow>("SELECT * FROM system_records WHERE id = ?", recordId)!;
    return reply.status(201).send({
      success: true,
      data: {
        id: row.id,
        table_id: row.table_id,
        data: parseData(row.data),
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    });
  });

  // ── PATCH /api/agentbase/systems/:id/records/:recordId ── edit a row
  app.patch("/api/agentbase/systems/:id/records/:recordId", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id, recordId } = request.params as { id: string; recordId: string };
    const system = loadOwnedSystem(id, userId);
    if (!system) {
      return reply
        .status(404)
        .send({ success: false, error: "System not found", code: "not_found" });
    }
    const record = one<RecordRow>(
      "SELECT * FROM system_records WHERE id = ? AND system_id = ?",
      recordId,
      id,
    );
    if (!record) {
      return reply
        .status(404)
        .send({ success: false, error: "Record not found", code: "not_found" });
    }
    const table = one<TableRow>("SELECT * FROM system_tables WHERE id = ?", record.table_id);
    const body = (request.body ?? {}) as { data?: unknown };
    const parsed = RecordDataSchema.safeParse(body.data ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }

    const columns = table ? parseColumns(table.columns) : [];
    const merged = parseData(record.data);
    for (const col of columns) {
      if (!(col.key in parsed.data)) continue;
      const v = parsed.data[col.key];
      if (v === undefined || v === null || v === "") {
        delete merged[col.key];
        continue;
      }
      if (col.type === "number" || col.type === "currency") {
        const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
        merged[col.key] = Number.isFinite(n) ? n : 0;
      } else {
        merged[col.key] = String(v).slice(0, 2000);
      }
    }

    dbRun(
      "UPDATE system_records SET data = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      toJson(merged),
      recordId,
    );
    touchSystem(id);
    const row = one<RecordRow>("SELECT * FROM system_records WHERE id = ?", recordId)!;
    return {
      success: true,
      data: {
        id: row.id,
        table_id: row.table_id,
        data: parseData(row.data),
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    };
  });

  // ── DELETE /api/agentbase/systems/:id/records/:recordId ── delete a row
  app.delete("/api/agentbase/systems/:id/records/:recordId", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id, recordId } = request.params as { id: string; recordId: string };
    const system = loadOwnedSystem(id, userId);
    if (!system) {
      return reply
        .status(404)
        .send({ success: false, error: "System not found", code: "not_found" });
    }
    const record = one<RecordRow>(
      "SELECT id FROM system_records WHERE id = ? AND system_id = ?",
      recordId,
      id,
    );
    if (!record) {
      return reply
        .status(404)
        .send({ success: false, error: "Record not found", code: "not_found" });
    }
    dbRun("DELETE FROM system_records WHERE id = ?", recordId);
    touchSystem(id);
    return { success: true, data: { deleted: true } };
  });
}
