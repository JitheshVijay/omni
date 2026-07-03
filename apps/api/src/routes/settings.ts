// User settings + a status view of configured API keys and local storage.
// Key VALUES never leave the server — only configured flags and, for
// OpenRouter, the last four characters for recognizability.
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { z } from "zod";
import { env } from "@omni/env-config";
import { DATA_DIR, nowISO, one, run, vecAvailable } from "@omni/sdk";
import type { AuthenticatedRequest } from "../middleware/auth.js";

interface SettingsRow {
  user_id: string;
  default_model: string;
  theme: string;
  updated_at: string;
}

const SettingsPatchSchema = z.object({
  default_model: z.string().min(1).optional(),
  theme: z.enum(["light", "dark", "system"]).optional(),
});

function loadOrCreateSettings(userId: string): SettingsRow {
  run(
    "INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING",
    userId,
  );
  return one<SettingsRow>(
    "SELECT * FROM user_settings WHERE user_id = ?",
    userId,
  ) as SettingsRow;
}

function keyStatus() {
  const or = env.OPENROUTER_API_KEY ?? "";
  return {
    openrouter: {
      configured: or.length > 0,
      keyTail: or.length >= 4 ? or.slice(-4) : null,
    },
    exa: { configured: !!env.EXA_API_KEY },
    elevenlabs: { configured: !!env.ELEVENLABS_API_KEY },
    llamaparse: { configured: !!env.LLAMAPARSE_API_KEY },
  };
}

function storageStatus() {
  const tables =
    one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )?.n ?? 0;
  return {
    dataDir: DATA_DIR,
    dbPath: join(DATA_DIR, "omni.db"),
    vec: vecAvailable,
    tables,
  };
}

export async function settingsRoutes(app: FastifyInstance) {
  // ── GET /api/settings ──
  app.get("/api/settings", async (request) => {
    const { userId } = request as AuthenticatedRequest;
    const settings = loadOrCreateSettings(userId);
    return {
      success: true,
      data: {
        default_model: settings.default_model,
        theme: settings.theme,
        keys: keyStatus(),
        storage: storageStatus(),
      },
    };
  });

  // ── PATCH /api/settings ──
  app.patch("/api/settings", async (request, reply) => {
    const { userId } = request as AuthenticatedRequest;
    const parsed = SettingsPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const body = parsed.data;
    loadOrCreateSettings(userId);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.default_model !== undefined) {
      sets.push("default_model = ?");
      params.push(body.default_model);
    }
    if (body.theme !== undefined) {
      sets.push("theme = ?");
      params.push(body.theme);
    }
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      params.push(nowISO());
      run(
        `UPDATE user_settings SET ${sets.join(", ")} WHERE user_id = ?`,
        ...params,
        userId,
      );
    }
    const updated = one<SettingsRow>(
      "SELECT * FROM user_settings WHERE user_id = ?",
      userId,
    ) as SettingsRow;
    return {
      success: true,
      data: {
        default_model: updated.default_model,
        theme: updated.theme,
        keys: keyStatus(),
        storage: storageStatus(),
      },
    };
  });
}
