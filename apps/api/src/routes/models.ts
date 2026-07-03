// Model catalog: the curated CHAT_MODELS registry flagged with live
// availability (intersection with OpenRouter's model list), plus a raw
// OpenRouter proxy for power users.
import type { FastifyInstance } from "fastify";
import { CHAT_MODELS } from "@omni/sdk";
import { getOpenRouterModels } from "../lib/openrouter-models.js";

export async function modelsRoutes(app: FastifyInstance) {
  // ── GET /api/models ──
  app.get("/api/models", async () => {
    const openRouterModels = await getOpenRouterModels();
    const liveIds = new Set(openRouterModels.map((m) => m.id));
    // When the catalog fetch fails ([]), assume everything is available
    // rather than graying out the whole picker.
    const catalogKnown = liveIds.size > 0;
    const models = CHAT_MODELS.map((m) => ({
      ...m,
      available: catalogKnown ? liveIds.has(m.id) : true,
    }));
    return { success: true, data: { models } };
  });

  // ── GET /api/models/openrouter ──
  app.get("/api/models/openrouter", async () => {
    const models = await getOpenRouterModels();
    return { success: true, data: { models } };
  });
}
