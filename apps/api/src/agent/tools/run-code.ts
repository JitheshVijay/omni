// run_code — a locked-down Deno subprocess sandbox.
//
//   deno run --no-prompt --no-remote --allow-read=<ws> --allow-write=<ws>
//            --v8-flags=--max-old-space-size=512 [--allow-net] main.ts
//
// cwd = ${DATA_DIR}/runs/<runId>/workspace, minimal env (PATH + HOME=ws),
// 120s wall timeout -> SIGKILL, also killed on ctx.signal. Combined
// stdout+stderr hard-capped at 32KB. Files the script leaves in the
// workspace are reported by name (not auto-imported to Drive in v1).
//
// Network is OFF by default. When args.allow_network is truthy the tool
// reclassifies to write_external (see classifyRunCode) so the loop stages
// a confirmation card before --allow-net is ever added.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@omni/sdk";
import { listWorkspaceFiles } from "../workspace.js";
import type { AgentTool, AgentToolCtx, ToolResult } from "./types.js";

const WALL_TIMEOUT_MS = 120_000;
const OUTPUT_CAP_BYTES = 32 * 1024;
const DENO_CANDIDATES = ["/opt/homebrew/bin/deno", "/usr/local/bin/deno", "deno"];

export const RUN_CODE_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description:
        "TypeScript/JavaScript source to run under Deno. Reads/writes are confined to the run workspace (cwd). Print results to stdout.",
    },
    allow_network: {
      type: "boolean",
      description:
        "Request outbound network access. Requires explicit user confirmation before the code runs.",
    },
  },
  required: ["code"],
  additionalProperties: false,
};

/** write_internal normally; write_external when network is requested. */
export function classifyRunCode(args: Record<string, unknown>): AgentTool["kind"] {
  return args.allow_network ? "write_external" : "write_internal";
}

function friendly(content: string): ToolResult {
  return { content };
}

async function runCode(
  args: Record<string, unknown>,
  ctx: AgentToolCtx,
): Promise<ToolResult> {
  const code = typeof args.code === "string" ? args.code : "";
  if (!code.trim()) return friendly("No code provided.");
  const allowNet = Boolean(args.allow_network);
  const ws = ctx.workspaceDir;

  const mainPath = join(ws, "main.ts");
  try {
    await writeFile(mainPath, code, "utf8");
  } catch (err) {
    return friendly(
      `Could not write the script to the workspace: ${(err as Error).message}`,
    );
  }
  const before = new Set(await listWorkspaceFiles(ctx.runId));

  const denoArgs = [
    "run",
    "--no-prompt",
    "--no-remote",
    `--allow-read=${ws}`,
    `--allow-write=${ws}`,
    "--v8-flags=--max-old-space-size=512",
    ...(allowNet ? ["--allow-net"] : []),
    "main.ts",
  ];

  return await new Promise<ToolResult>((resolve) => {
    let settled = false;
    const done = (r: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(DENO_CANDIDATES[0], denoArgs, {
        cwd: ws,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: ws },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      done(unavailable(err));
      return;
    }

    let out = "";
    let capped = false;
    const append = (buf: Buffer) => {
      if (capped) return;
      out += buf.toString("utf8");
      if (Buffer.byteLength(out, "utf8") >= OUTPUT_CAP_BYTES) {
        out = out.slice(0, OUTPUT_CAP_BYTES);
        capped = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      void finish(null, true);
    }, WALL_TIMEOUT_MS);
    timer.unref?.();

    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done(friendly("Code execution was cancelled."));
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const finish = async (exitCode: number | null, timedOut: boolean) => {
      const after = await listWorkspaceFiles(ctx.runId);
      const created = after.filter((f) => f !== "main.ts" && !before.has(f));
      const parts: string[] = [];
      if (timedOut) parts.push(`[timed out after ${WALL_TIMEOUT_MS / 1000}s — killed]`);
      else parts.push(`[exit code ${exitCode ?? "unknown"}]`);
      if (capped) parts.push("[output truncated at 32KB]");
      parts.push(out.trim().length > 0 ? out.trim() : "(no output)");
      if (created.length > 0) {
        parts.push(`\nFiles created in the workspace: ${created.join(", ")}`);
      }
      done(friendly(parts.join("\n")));
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        done(unavailable(err));
        return;
      }
      done(friendly(`Failed to run code: ${err.message}`));
    });
    child.on("close", (codeNum) => {
      void finish(codeNum, false);
    });
  });
}

function unavailable(err: unknown): ToolResult {
  logger.warn({ err: (err as Error)?.message }, "[run_code] deno unavailable");
  return friendly(
    "Code execution is unavailable: the Deno runtime is not installed on this server. " +
      "Continue without running code — reason through the problem directly instead.",
  );
}

export const runCodeTool: AgentTool = {
  name: "run_code",
  description:
    "Execute a short TypeScript/JavaScript program in a sandboxed Deno runtime (no network by default). " +
    "Use it to compute, transform data, or process a file you first wrote into the workspace. Reads/writes are confined to the workspace directory.",
  parameters: RUN_CODE_PARAMETERS,
  kind: "write_internal",
  classify: classifyRunCode,
  maxResultChars: 8000,
  timeoutMs: WALL_TIMEOUT_MS + 5_000,
  label: (args) =>
    args.allow_network ? "Running code (network requested)" : "Running code",
  execute: runCode,
};
