// Custom Agents store REST. Ready-made Super-Agent presets (a goal_template +
// a default budget) users browse and launch in one click, plus save-your-own,
// over one flat `agent_presets` table:
//   GET    /api/agent-presets?tab=&category=&q=  — filtered list (community | mine)
//   POST   /api/agent-presets                      — create a user preset (publisher 'You')
//   DELETE /api/agent-presets/:id                  — delete own, non-builtin preset
//   POST   /api/agent-presets/:id/launch {input?}  — start a real agent run
//
// Launching substitutes the caller's {{input}} into goal_template, inserts an
// agent_runs row (status 'queued', budget from the preset, title from the
// preset name) exactly like routes/agent.ts POST, then fires startRun() and
// returns { run_id } so the frontend can navigate to /agent/:id. Envelope
// conventions mirror routes/skills.ts (named-key LIST, bare CREATE, flat error
// envelope).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, one, run as dbRun, nowISO, uuid } from "@omni/sdk";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { startRun } from "../agent/orchestrator.js";

interface AgentPresetRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  accent: string;
  goal_template: string;
  budget_usd: number;
  publisher: string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

const CATEGORIES = ["Research", "Business", "Content", "Personal", "Ops"] as const;

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  category: z.enum(CATEGORIES).optional(),
  icon: z.string().min(1).max(40).optional(),
  accent: z.string().min(1).max(120).optional(),
  goal_template: z.string().min(1).max(4000),
  budget_usd: z.number().positive().max(50).optional(),
});

const LaunchSchema = z.object({
  input: z.string().max(4000).optional(),
});

const ListQuerySchema = z.object({
  tab: z.enum(["community", "mine"]).optional(),
  category: z.enum(CATEGORIES).optional(),
  q: z.string().max(200).optional(),
});

function loadOwnedPreset(id: string, userId: string): AgentPresetRow | undefined {
  return one<AgentPresetRow>(
    "SELECT * FROM agent_presets WHERE id = ? AND user_id = ?",
    id,
    userId,
  );
}

// Resolve {{input}} in a goal template. When the preset takes input but none is
// given, the placeholder is simply stripped so the base goal still works.
// Tolerates optional surrounding whitespace: "{{ input }}".
function resolveTemplate(template: string, input?: string): string {
  const value = (input ?? "").trim();
  const substituted = template.replace(/\{\{\s*input\s*\}\}/g, value);
  return substituted.replace(/\n{3,}/g, "\n\n").trim();
}

export async function agentPresetRoutes(app: FastifyInstance) {
  // ── GET /api/agent-presets ── filtered list (community | mine)
  app.get("/api/agent-presets", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const parsed = ListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const { tab = "community", category, q } = parsed.data;

    const where: string[] = ["user_id = ?"];
    const params: unknown[] = [userId];

    // Community = the curated set (built-ins + anything not authored by "You").
    // Mine = the user's own created presets.
    if (tab === "mine") {
      where.push("is_builtin = 0 AND publisher = 'You'");
    } else {
      where.push("(is_builtin = 1 OR publisher <> 'You')");
    }
    if (category) {
      where.push("category = ?");
      params.push(category);
    }
    if (q && q.trim()) {
      where.push("(name LIKE ? OR description LIKE ?)");
      const like = `%${q.trim()}%`;
      params.push(like, like);
    }

    const rows = all<AgentPresetRow>(
      `SELECT * FROM agent_presets WHERE ${where.join(" AND ")}
        ORDER BY is_builtin DESC, created_at DESC`,
      ...params,
    );
    return { success: true, data: { presets: rows } };
  });

  // ── POST /api/agent-presets ── create a user preset (bare row back)
  app.post("/api/agent-presets", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const parsed = CreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const body = parsed.data;
    const id = uuid();
    dbRun(
      `INSERT INTO agent_presets
         (id, user_id, name, description, category, icon, accent,
          goal_template, budget_usd, publisher, is_builtin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'You', 0)`,
      id,
      userId,
      body.name,
      body.description ?? "",
      body.category ?? "Research",
      body.icon ?? "Bot",
      body.accent ?? "from-accent to-accent2",
      body.goal_template,
      body.budget_usd ?? 1.5,
    );
    const row = loadOwnedPreset(id, userId)!;
    return reply.status(201).send({ success: true, data: row });
  });

  // ── DELETE /api/agent-presets/:id ── own, non-builtin only
  app.delete("/api/agent-presets/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const row = loadOwnedPreset(id, userId);
    if (!row) {
      return reply
        .status(404)
        .send({ success: false, error: "Preset not found", code: "not_found" });
    }
    if (row.is_builtin === 1) {
      return reply.status(403).send({
        success: false,
        error: "Built-in agents can't be deleted",
        code: "builtin_readonly",
      });
    }
    dbRun("DELETE FROM agent_presets WHERE id = ?", id);
    return { success: true, data: { deleted: true } };
  });

  // ── POST /api/agent-presets/:id/launch ── create + start a real agent run
  app.post("/api/agent-presets/:id/launch", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const parsed = LaunchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const preset = loadOwnedPreset(id, userId);
    if (!preset) {
      return reply
        .status(404)
        .send({ success: false, error: "Preset not found", code: "not_found" });
    }

    const goal = resolveTemplate(preset.goal_template, parsed.data.input);
    const runId = uuid();
    const title = preset.name.replace(/\s+/g, " ").trim().slice(0, 120);
    dbRun(
      `INSERT INTO agent_runs (id, user_id, hub_id, thread_id, title, goal, status, model, budget_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      runId,
      userId,
      null,
      null,
      title,
      goal,
      null,
      preset.budget_usd,
      nowISO(),
    );
    // Fire-and-forget; the orchestrator owns its AbortController.
    void startRun(runId).catch((err) => {
      request.log.error({ err, runId }, "[agent-presets] startRun crashed");
    });
    return reply.status(201).send({ success: true, data: { run_id: runId } });
  });
}
