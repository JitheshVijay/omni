// Skills library REST. The Skills marketplace is browse + create over one
// flat `skills` table:
//   GET    /api/skills?tab=&q=&role=&output=  — filtered list (community | mine)
//   POST   /api/skills                        — create a user skill (publisher 'You')
//   DELETE /api/skills/:id                     — delete own, non-builtin skill
//   POST   /api/skills/:id/run {input?}        — resolve the prompt template
//
// The run route does NOT generate anything server-side: it substitutes the
// caller's {{input}} into prompt_template and returns the resolved seed
// { target, generator?, prompt }. The frontend routes that seed to the right
// place (a new chat, or a generator hub). Envelope conventions mirror
// routes/workflows.ts (named-key LIST, bare CREATE, flat error envelope).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, one, run as dbRun, uuid } from "@omni/sdk";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getGenerator } from "../generators/registry.js";
import { OUTPUT_ACCENT } from "../lib/skills-seed.js";

interface SkillRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  publisher: string;
  role: string;
  output: string;
  target: string;
  prompt_template: string;
  accent: string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

const ROLES = [
  "Sales",
  "Marketer",
  "Product",
  "Researcher",
  "Designer",
  "Engineer",
  "Founder",
  "General",
] as const;

const OUTPUTS = ["doc", "slides", "sheet", "image", "chat", "data"] as const;

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  role: z.enum(ROLES).optional(),
  output: z.enum(OUTPUTS).optional(),
  // A generator name or 'chat'. Validated against the registry below.
  target: z.string().min(1).max(40).optional(),
  prompt_template: z.string().min(1).max(8000),
});

const RunSchema = z.object({
  input: z.string().max(8000).optional(),
});

const ListQuerySchema = z.object({
  tab: z.enum(["community", "mine"]).optional(),
  q: z.string().max(200).optional(),
  role: z.enum(ROLES).optional(),
  output: z.enum(OUTPUTS).optional(),
});

function loadOwnedSkill(id: string, userId: string): SkillRow | undefined {
  return one<SkillRow>("SELECT * FROM skills WHERE id = ? AND user_id = ?", id, userId);
}

// Resolve {{input}} in a template. When the skill takes input but none is
// given, the placeholder is simply stripped so the base instruction still
// works. Tolerates optional surrounding whitespace: "{{ input }}".
function resolveTemplate(template: string, input?: string): string {
  const value = (input ?? "").trim();
  const substituted = template.replace(/\{\{\s*input\s*\}\}/g, value);
  // Collapse the leftover blank lines a stripped placeholder can leave behind.
  return substituted.replace(/\n{3,}/g, "\n\n").trim();
}

export async function skillsRoutes(app: FastifyInstance) {
  // ── GET /api/skills ── filtered list (community | mine)
  app.get("/api/skills", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const parsed = ListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const { tab = "community", q, role, output } = parsed.data;

    const where: string[] = ["user_id = ?"];
    const params: unknown[] = [userId];

    // Community = the curated set (built-ins + anything not authored by "You").
    // Mine = the user's own created skills.
    if (tab === "mine") {
      where.push("is_builtin = 0 AND publisher = 'You'");
    } else {
      where.push("(is_builtin = 1 OR publisher <> 'You')");
    }
    if (role) {
      where.push("role = ?");
      params.push(role);
    }
    if (output) {
      where.push("output = ?");
      params.push(output);
    }
    if (q && q.trim()) {
      where.push("(name LIKE ? OR description LIKE ?)");
      const like = `%${q.trim()}%`;
      params.push(like, like);
    }

    const rows = all<SkillRow>(
      `SELECT * FROM skills WHERE ${where.join(" AND ")}
        ORDER BY is_builtin DESC, created_at DESC`,
      ...params,
    );
    return { success: true, data: { skills: rows } };
  });

  // ── POST /api/skills ── create a user skill (bare row back)
  app.post("/api/skills", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const parsed = CreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const body = parsed.data;
    const output = body.output ?? "chat";
    const target = body.target ?? "chat";

    // Target must be 'chat' or a registered generator so /run can hand off.
    if (target !== "chat" && !getGenerator(target)) {
      return reply.status(400).send({
        success: false,
        error: `Unknown target '${target}'`,
        code: "unknown_target",
      });
    }

    const accent = OUTPUT_ACCENT[output as keyof typeof OUTPUT_ACCENT] ?? OUTPUT_ACCENT.chat;
    const id = uuid();
    dbRun(
      `INSERT INTO skills
         (id, user_id, name, description, publisher, role, output, target,
          prompt_template, accent, is_builtin)
       VALUES (?, ?, ?, ?, 'You', ?, ?, ?, ?, ?, 0)`,
      id,
      userId,
      body.name,
      body.description ?? "",
      body.role ?? "General",
      output,
      target,
      body.prompt_template,
      accent,
    );
    const row = loadOwnedSkill(id, userId)!;
    return reply.status(201).send({ success: true, data: row });
  });

  // ── DELETE /api/skills/:id ── own, non-builtin only
  app.delete("/api/skills/:id", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const row = loadOwnedSkill(id, userId);
    if (!row) {
      return reply.status(404).send({ success: false, error: "Skill not found", code: "not_found" });
    }
    if (row.is_builtin === 1) {
      return reply.status(403).send({
        success: false,
        error: "Built-in skills can't be deleted",
        code: "builtin_readonly",
      });
    }
    dbRun("DELETE FROM skills WHERE id = ?", id);
    return { success: true, data: { deleted: true } };
  });

  // ── POST /api/skills/:id/run ── resolve the template (no server-side gen)
  app.post("/api/skills/:id/run", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const { id } = request.params as { id: string };
    const parsed = RunSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const row = loadOwnedSkill(id, userId);
    if (!row) {
      return reply.status(404).send({ success: false, error: "Skill not found", code: "not_found" });
    }

    const prompt = resolveTemplate(row.prompt_template, parsed.data.input);
    const generator = row.target !== "chat" && getGenerator(row.target) ? row.target : undefined;

    return {
      success: true,
      data: {
        target: row.target,
        generator, // a registered generator name, or undefined for chat
        prompt,
      },
    };
  });
}
