// Shared structured logger for the SDK, the API, and any consumer that
// doesn't have a request-scoped logger handy.
//
// Imported as `import { logger } from "@omni/sdk"`.
//
// Three destinations based on environment:
//   - development     -> pino-pretty to stdout (human-readable)
//   - test            -> silent (no output during test runs)
//   - everything else -> single-line JSON on stdout
//
// Reads process.env directly (not @omni/env-config) so the logger can be
// constructed even before env validation runs — a logger must never be
// the thing that prevents an error from being reported.

import pino from "pino";

const nodeEnv = process.env.NODE_ENV;
const isDevelopment = nodeEnv === "development" || nodeEnv === undefined;
const isTest = nodeEnv === "test";

function buildLoggerOptions(service?: string): pino.LoggerOptions {
  const base: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL ?? "info",
    ...(service ? { name: service } : {}),
    // Normalise any `err` passed to a log call into { type, message,
    // stack } so errors serialize usefully instead of as `{}`.
    serializers: { err: pino.stdSerializers.err },
  };

  if (isTest) {
    return { ...base, level: "silent" };
  }

  if (isDevelopment) {
    return {
      ...base,
      transport: {
        target: "pino-pretty",
        options: {
          translateTime: "HH:MM:ss Z",
          ignore: "pid,hostname",
        },
      },
    };
  }

  // Production: structured single-line JSON on stdout.
  return base;
}

// Allow callers (Fastify, workers, scripts) to construct a logger that
// picks up the same env-driven transport choice with a different
// service tag.
export function createLogger(service?: string): pino.Logger {
  return pino(buildLoggerOptions(service));
}

export const logger: pino.Logger = createLogger("omni");

export type Logger = typeof logger;
