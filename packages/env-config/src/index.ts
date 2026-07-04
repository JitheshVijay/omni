// Zod-validated environment config, loaded once at import time.
//
// Looks for a `.env` file by walking up from cwd (max 5 levels) so the
// monorepo root `.env` is found whether the process starts from the repo
// root, apps/api, or a package dir. Invalid/missing required vars print
// the issues and exit(1) — failing the boot fast is better than limping
// along with a half-configured process.

import { z } from "zod";
import dotenv from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// Walk up to find .env at the monorepo root.
function findEnvFile(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const envPath = resolve(dir, ".env");
    if (existsSync(envPath)) return envPath;
    dir = resolve(dir, "..");
  }
  return undefined;
}

dotenv.config({ path: findEnvFile() });

const envSchema = z.object({
  // ── Server ─────────────────────────────────────────────────────────
  PORT: z.string().default("4100"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  // Logger level override. Defaults to "info" when unset (see logger.ts).
  LOG_LEVEL: z.string().optional(),
  // Comma-separated list of allowed CORS origins (web dev server, etc.).
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // ── AI (required) ──────────────────────────────────────────────────
  // Everything routes through OpenRouter; the app is useless without it,
  // so fail boot when missing/empty.
  OPENROUTER_API_KEY: z
    .string()
    .min(1, "OPENROUTER_API_KEY is required — get one at https://openrouter.ai"),

  // ── Storage ────────────────────────────────────────────────────────
  // Data root override. Defaults to ~/.omni (omni.db, drive/, artifacts/,
  // runs/). Resolved in @omni/sdk's db.ts.
  OMNI_DATA_DIR: z.string().optional(),

  // ── Auth (single-user local in v1) ─────────────────────────────────
  // AUTH_MODE is an enum so multi-user auth is a config change, not a
  // rewrite. "local" injects the fixed user below on every request.
  AUTH_MODE: z.enum(["local", "supabase"]).default("local"),
  LOCAL_USER_ID: z
    .string()
    .default("00000000-0000-4000-a000-000000000001"),
  LOCAL_USER_EMAIL: z.string().default("local@omni.dev"),

  // ── Optional providers (fail-soft; features degrade gracefully) ────
  // Exa.ai semantic web search (agent web_search tool, source lookup).
  EXA_API_KEY: z.string().optional(),
  // ElevenLabs: Scribe STT dictation + TTS read-aloud/podcast.
  ELEVENLABS_API_KEY: z.string().optional(),
  // LlamaParse managed PDF parsing; falls back to pdf-parse when unset.
  LLAMAPARSE_API_KEY: z.string().optional(),
  // LlamaParse tier: fast / cost_effective / agentic / agentic_plus.
  LLAMAPARSE_TIER: z.string().default("agentic"),
  // Composio: external-app integrations (Gmail/Calendar Secretary) with
  // managed OAuth. Whole layer is a no-op until this is set.
  COMPOSIO_API_KEY: z.string().optional(),

  // ── LangSmith tracing (off by default) ─────────────────────────────
  LANGSMITH_TRACING: z.string().optional(),
  LANGSMITH_API_KEY: z.string().optional(),
  LANGCHAIN_PROJECT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment configuration:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
