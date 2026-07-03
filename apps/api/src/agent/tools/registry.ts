// Agent tool registry: the hand-written tools + run_code + one adapter per
// registered generator (create_<name>, and revise_<name> where the generator
// supports revision). The orchestrator resolves tools by name through here.
import { logger, one, run } from "@omni/sdk";
import { listGenerators } from "../../generators/registry.js";
import type { ArtifactRow, GenEvent, GeneratorService } from "../../generators/types.js";
import { toArtifactSummary } from "../../generators/types.js";
import { BUILTIN_TOOLS } from "./builtin.js";
import { runCodeTool } from "./run-code.js";
import { zodToJsonSchema } from "./zod-to-jsonschema.js";
import type { AgentTool, AgentToolCtx, ToolResult } from "./types.js";

function previewInput(args: Record<string, unknown>): string {
  const p = (args.prompt ?? args.text ?? args.instruction ?? "") as string;
  const s = String(p).replace(/\s+/g, " ").trim();
  return s ? `"${s.slice(0, 50)}"` : "";
}

/** Bridge a generator's GenEvent stream onto the agent's live event bus. */
function bridgeGenCtx(ctx: AgentToolCtx) {
  return {
    userId: ctx.userId,
    signal: ctx.signal,
    emit: (e: GenEvent) => {
      // Forward coarse progress as delta text; artifacts are handled by the
      // orchestrator from execute()'s return value, so we don't re-emit them.
      if (e.type === "status") ctx.emit({ type: "delta", text: `\n_${e.label}…_` });
    },
  };
}

function linkArtifactRunId(runId: string, artifactId: string): ArtifactRow | undefined {
  run(
    "UPDATE artifacts SET run_id = ? WHERE id = ? AND run_id IS NULL",
    runId,
    artifactId,
  );
  return one<ArtifactRow>("SELECT * FROM artifacts WHERE id = ?", artifactId);
}

function createTool(gen: GeneratorService<unknown>): AgentTool {
  let parameters: Record<string, unknown>;
  try {
    parameters = zodToJsonSchema(gen.inputSchema);
  } catch (err) {
    logger.warn({ err: (err as Error).message, gen: gen.name }, "[registry] zod->schema failed");
    parameters = { type: "object", properties: {}, additionalProperties: true };
  }
  return {
    name: `create_${gen.name}`,
    description: gen.toolDescription,
    parameters,
    kind: "write_internal",
    maxResultChars: 2000,
    label: (args) => `Creating ${gen.name} ${previewInput(args)}`.trim(),
    async execute(args, ctx): Promise<ToolResult> {
      const summary = await gen.run(args, bridgeGenCtx(ctx));
      const row = linkArtifactRunId(ctx.runId, summary.id);
      const final = row ? toArtifactSummary(row) : summary;
      return {
        content: JSON.stringify({ artifact_id: final.id, title: final.title, kind: final.kind }),
        artifacts: [{ artifactId: final.id }],
      };
    },
  };
}

function reviseTool(gen: GeneratorService<unknown>): AgentTool {
  return {
    name: `revise_${gen.name}`,
    description: `Revise an existing ${gen.name} artifact with a natural-language instruction. Produces a new version linked to the original.`,
    parameters: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "The artifact to revise." },
        instruction: { type: "string", description: "What to change." },
      },
      required: ["artifact_id", "instruction"],
      additionalProperties: false,
    },
    kind: "write_internal",
    maxResultChars: 2000,
    label: (args) => `Revising ${gen.name} ${previewInput(args)}`.trim(),
    async execute(args, ctx): Promise<ToolResult> {
      const artifactId = typeof args.artifact_id === "string" ? args.artifact_id : "";
      const instruction = typeof args.instruction === "string" ? args.instruction : "";
      if (!artifactId || !instruction) {
        return { content: "artifact_id and instruction are both required." };
      }
      const summary = await gen.revise!(artifactId, instruction, bridgeGenCtx(ctx));
      const row = linkArtifactRunId(ctx.runId, summary.id);
      const final = row ? toArtifactSummary(row) : summary;
      return {
        content: JSON.stringify({ artifact_id: final.id, title: final.title, kind: final.kind }),
        artifacts: [{ artifactId: final.id }],
      };
    },
  };
}

let cached: AgentTool[] | null = null;

/** The full tool set advertised to the agent. Built once, memoized. */
export function getAgentTools(): AgentTool[] {
  if (cached) return cached;
  const generatorTools: AgentTool[] = [];
  for (const gen of listGenerators() as GeneratorService<unknown>[]) {
    generatorTools.push(createTool(gen));
    if (gen.revise) generatorTools.push(reviseTool(gen));
  }
  cached = [...BUILTIN_TOOLS, runCodeTool, ...generatorTools];
  return cached;
}

/** name -> tool lookup for the orchestrator. */
export function getToolMap(): Map<string, AgentTool> {
  const map = new Map<string, AgentTool>();
  for (const t of getAgentTools()) map.set(t.name, t);
  return map;
}

/** OpenAI/OpenRouter tool specs derived from the tool set. */
export function getToolSpecs(): Array<Record<string, unknown>> {
  return getAgentTools().map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
