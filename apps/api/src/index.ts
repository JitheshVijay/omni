// @omni/api bootstrap — adapted from Flo101's apps/api/src/index.ts
// (pino loggerInstance, tolerant JSON parser, neutral error mapping,
// cors -> rateLimit -> helmet -> swagger(dev) -> multipart, auth hook,
// structured onResponse logging) plus Omni's SQLite migrations and the
// background Drive ingestion loop.
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import multipart from "@fastify/multipart";
import { env } from "@omni/env-config";
import {
  createLogger,
  ensureVecIndex,
  runMigrations,
  vecAvailable,
} from "@omni/sdk";
import { authMiddleware } from "./middleware/auth.js";
import { startDriveIndexLoop } from "./lib/drive-index.js";
import { startAgentRecoverySweep } from "./agent/recovery.js";
import { workflowRoutes } from "./routes/workflows.js";
import { startWorkflowCron } from "./lib/workflow-cron.js";
import { secretaryRoutes } from "./routes/secretary.js";
import { voiceAgentRoutes } from "./routes/voice-agent.js";
import { searchRoutes } from "./routes/search.js";
import { skillsRoutes } from "./routes/skills.js";
import { agentbaseRoutes } from "./routes/agentbase.js";
import { seedBuiltinSkills } from "./lib/skills-seed.js";
import { ensureSearchVecIndex, reindexAll } from "./lib/search-index.js";
import { startWorkspaceSweep } from "./agent/workspace.js";
import { chatRoutes } from "./routes/chat.js";
import { modelsRoutes } from "./routes/models.js";
import { hubsRoutes } from "./routes/hubs.js";
import { driveRoutes } from "./routes/drive.js";
import { settingsRoutes } from "./routes/settings.js";
import { agentRoutes } from "./routes/agent.js";
import { voiceRoutes } from "./routes/voice.js";
import { generateRoutes } from "./routes/generate.js";

// Single pino instance shared between Fastify (request.log) and the SDK.
const sharedLogger = createLogger("omni-api");

// Default per-request "incoming request"/"request completed" lines are
// silenced (they log the full URL with query strings); the onResponse hook
// below emits one structured line per request with the query stripped.
const app = Fastify({
  bodyLimit: 30 * 1024 * 1024, // 30MB
  loggerInstance: sharedLogger,
  disableRequestLogging: true,
});

// Tolerate an EMPTY body on application/json requests. Fastify's default
// parser throws FST_ERR_CTP_EMPTY_JSON_BODY for a bodyless POST that still
// carries the JSON content-type — a very common client mistake on action
// POSTs (e.g. regenerate). Treat empty as {}; each route's own zod
// validation then complains if a body was actually required. Malformed
// JSON still 400s.
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (_req, body, done) => {
    const raw = ((body as string) ?? "").trim();
    if (raw === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  },
);

// Map Fastify's FST_ERR_* codes to neutral messages (no framework
// fingerprinting), pass sub-500 errors through without the code prefix,
// and log+genericize everything else.
const FST_CODE_MAP: Record<string, { status: number; code: string; message: string }> = {
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    status: 415,
    code: "invalid_content_type",
    message: "Unsupported content type.",
  },
  FST_ERR_VALIDATION: { status: 400, code: "invalid_request", message: "Invalid request." },
  FST_ERR_BAD_URL: { status: 400, code: "invalid_request", message: "Invalid request." },
  FST_ERR_NOT_FOUND: { status: 404, code: "not_found", message: "Not found." },
};
app.setErrorHandler((err, request, reply) => {
  const e = err as { code?: string; statusCode?: number; message?: string };
  const fstMap = e.code ? FST_CODE_MAP[e.code] : undefined;
  if (fstMap) {
    return reply
      .status(fstMap.status)
      .send({ success: false, error: fstMap.message, code: fstMap.code });
  }
  if (e.statusCode && e.statusCode < 500) {
    return reply
      .status(e.statusCode)
      .send({ success: false, error: e.message ?? "Bad request" });
  }
  request.log.error({ err, route: request.url, method: request.method }, "unhandled error");
  return reply
    .status(500)
    .send({ success: false, error: "Internal server error", code: "internal_error" });
});

async function main() {
  // ── CORS: explicit allowlist (web dev origin + CORS_ALLOWED_ORIGINS) ──
  const defaultOrigins = ["http://localhost:5175", "http://127.0.0.1:5175"];
  const envOrigins = (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedOriginSet = new Set<string>([...defaultOrigins, ...envOrigins]);

  await app.register(cors, {
    origin: (origin, cb) => {
      // No Origin header (curl, server-to-server) — accept.
      if (!origin) return cb(null, true);
      if (allowedOriginSet.has(origin)) return cb(null, true);
      sharedLogger.warn({ origin }, "[CORS] rejected cross-origin request");
      cb(new Error("Origin not allowed"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    // Last-Event-ID: sent by the agent-run SSE client on reconnect so the
    // server resumes from the last delivered step. Cache-Control: some SSE
    // clients set it. Both must be allow-listed or the preflight fails.
    allowedHeaders: ["Content-Type", "Authorization", "Last-Event-ID", "Cache-Control"],
  });

  // ── Rate limit: keyed by user when authenticated, IP otherwise ──
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const userId = (req as unknown as { userId?: string }).userId;
      return userId ? `u:${userId}` : `ip:${req.ip}`;
    },
  });

  // ── Helmet: JSON API defaults. CSP off (no HTML surface; would break the
  // dev swagger UI). CORP off so the web origin can inline-preview
  // /api/drive/files/:id/download?inline=1 blobs cross-origin. ──
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
  });

  // ── Swagger UI: development only ──
  if (env.NODE_ENV === "development") {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "Omni API",
          version: "0.1.0",
          description: "Local-first AI workspace API",
        },
      },
    });
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  // ── Health check (no auth) ──
  app.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  // ── Auth for all /api routes ──
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health" || request.url.startsWith("/docs")) return;
    if (request.url.startsWith("/api/")) {
      await authMiddleware(request, reply);
    }
  });

  // ── One structured log line per request (query string stripped) ──
  app.addHook("onResponse", (request, reply, done) => {
    if (request.url === "/health" || request.url.startsWith("/docs")) {
      done();
      return;
    }
    const userId = (request as unknown as { userId?: string }).userId;
    const route = request.url
      .split("?")[0]
      .replace(
        /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        "/:id",
      )
      .replace(/\/\d+/g, "/:id");
    const durationMs = Math.round(reply.elapsedTime);
    const status = reply.statusCode;
    const line = { userId, route, method: request.method, status, durationMs };
    if (status >= 500) {
      request.log.error(line, "request failed");
    } else if (status >= 400) {
      request.log.warn(line, "request rejected");
    } else if (durationMs > 5000) {
      request.log.warn(line, "slow request");
    } else {
      request.log.info(line, "request completed");
    }
    done();
  });

  // ── Migrations before anything can touch the tables ──
  const applied = runMigrations();
  app.log.info(
    { applied: applied.length, files: applied },
    `applied ${applied.length} migration(s)`,
  );
  ensureVecIndex();
  ensureSearchVecIndex();
  seedBuiltinSkills();
  if (vecAvailable) {
    app.log.info("sqlite-vec loaded — vector KNN enabled");
  } else {
    app.log.warn(
      "sqlite-vec unavailable — hub memory search falls back to JS cosine (slower, same results)",
    );
  }

  // ── Routes ──
  await app.register(chatRoutes);
  await app.register(modelsRoutes);
  await app.register(hubsRoutes);
  await app.register(driveRoutes);
  await app.register(settingsRoutes);
  await app.register(agentRoutes);
  await app.register(voiceRoutes);
  await app.register(generateRoutes);
  await app.register(workflowRoutes);
  await app.register(secretaryRoutes);
  await app.register(voiceAgentRoutes);
  await app.register(searchRoutes);
  await app.register(skillsRoutes);
  await app.register(agentbaseRoutes);

  // ── Start ──
  const port = parseInt(env.PORT, 10);
  await app.listen({ port, host: "127.0.0.1" });
  app.log.info(`Omni API running on http://localhost:${port}`);
  if (env.NODE_ENV === "development") {
    app.log.info(`Swagger docs at http://localhost:${port}/docs`);
  }

  // Background Drive ingestion (extract -> chunk -> embed -> hub memory).
  startDriveIndexLoop();

  // Super Agent: mark runs interrupted by a restart as failed+resumable, and
  // sweep stale per-run workspaces (run_code scratch dirs).
  startAgentRecoverySweep();
  startWorkspaceSweep();

  // Workflows: rehydrate cron schedules (missed-while-closed runs are missed).
  startWorkflowCron();

  // Global search: build/refresh the semantic index in the background.
  void reindexAll(env.LOCAL_USER_ID).catch((err) =>
    app.log.warn({ err }, "[search] boot reindex failed"),
  );

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down...`);
    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Last-resort handlers: a stray unhandled rejection anywhere (e.g. a
  // fire-and-forget indexing promise) must not take the process down.
  // Log the full stack and KEEP SERVING.
  const toError = (e: unknown): Error =>
    e instanceof Error ? e : new Error(typeof e === "string" ? e : String(e));
  process.on("unhandledRejection", (reason) => {
    app.log.error({ err: toError(reason) }, "unhandledRejection — logged, continuing");
  });
  process.on("uncaughtException", (err) => {
    app.log.error({ err }, "uncaughtException — logged, continuing");
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
