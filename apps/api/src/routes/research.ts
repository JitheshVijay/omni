// Deep Research SSE endpoint. POST /api/research streams:
//   :pad -> {status}* -> {delta}* -> {artifact} | {error}
// Body validation happens BEFORE the reply is hijacked so a bad request
// still gets a plain JSON 400 (same pattern as routes/generate.ts).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { openSSE } from "../lib/sse.js";
import { runResearch } from "../lib/research.js";

const ResearchSchema = z.object({
  question: z.string().min(3).max(2000),
});

export async function researchRoutes(app: FastifyInstance) {
  // ── POST /api/research (SSE) ──
  app.post("/api/research", async (request, reply) => {
    const authed = request as AuthenticatedRequest;
    // Validate BEFORE hijacking so bad requests still get a JSON 400.
    const parsed = ResearchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }

    const sse = openSSE(request, reply);
    const ac = new AbortController();
    sse.onClose(() => ac.abort());
    try {
      const artifact = await runResearch(authed.userId, parsed.data.question, {
        signal: ac.signal,
        emit: (e) => sse.send(e),
      });
      sse.sendTerminal({ type: "artifact", artifact });
    } catch (err) {
      request.log.error({ err }, "[research] run failed");
      sse.sendTerminal({
        type: "error",
        message: (err as Error).message?.slice(0, 300) ?? "Research failed",
      });
    } finally {
      sse.close();
    }
    return reply;
  });
}
