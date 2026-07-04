// Secretary agent tools: the user's connected Gmail + Google Calendar Composio
// actions, wrapped as AgentTool so the orchestrator treats them uniformly with
// the native tools. READ actions (search/list/get/read) run immediately; WRITE
// actions (send/create/delete/update/reply) are kind "write_external", so the
// orchestrator suspends for a confirmation card before running them — the whole
// point of the Secretary: no email is sent and no event created unconfirmed.
//
// Returns [] when Composio is unconfigured or the user has no ACTIVE connection,
// so the agent simply has no Secretary tools rather than erroring. The
// integrator splices getSecretaryTools(userId) into the agent tool registry.

import { logger } from "@omni/sdk";
import {
  composioEnabled,
  composioToolsForUser,
  composioToolKind,
  describeComposioAction,
  executeComposioTool,
  listConnections,
} from "../../lib/composio.js";
import type { AgentTool, ToolResult } from "./types.js";

interface OpenAIFnTool {
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * The connected Gmail/Calendar Composio actions as AgentTools. Empty when
 * Composio is off or nothing is actively connected. Never throws.
 */
export async function getSecretaryTools(userId: string): Promise<AgentTool[]> {
  if (!composioEnabled()) return [];

  const active = listConnections(userId)
    .filter((c) => c.status === "active")
    .map((c) => c.toolkit);
  if (active.length === 0) return [];

  let specs: OpenAIFnTool[];
  try {
    specs = (await composioToolsForUser(userId, active)) as OpenAIFnTool[];
  } catch (err) {
    logger.warn(`[secretary] tools fetch failed: ${(err as Error)?.message}`);
    return [];
  }

  const tools: AgentTool[] = [];
  for (const spec of specs) {
    const slug = spec.function?.name; // UPPERCASE Composio slug, e.g. GMAIL_SEND_EMAIL
    if (!slug) continue;
    const parameters =
      spec.function?.parameters && typeof spec.function.parameters === "object"
        ? spec.function.parameters
        : { type: "object", properties: {}, additionalProperties: true };
    const isRead = composioToolKind(slug) === "read";
    const label = describeComposioAction(slug);
    // The model addresses tools by lowercased name; we execute the original slug.
    const captureSlug = slug;

    const tool: AgentTool = {
      name: slug.toLowerCase(),
      description: spec.function?.description ?? label,
      parameters,
      kind: isRead ? "read" : "write_external",
      maxResultChars: 8000,
      label: () => label,
      async execute(args): Promise<ToolResult> {
        const out = await executeComposioTool(userId, captureSlug, args);
        return { content: out };
      },
    };
    if (!isRead) {
      // Long-form card copy (the orchestrator currently renders label(); this is
      // provided per the AgentTool contract for when it surfaces describe()).
      tool.describe = async () =>
        `${label}. Review the details below before confirming — this will run against your real ${
          captureSlug.startsWith("GMAIL") ? "Gmail" : "Google Calendar"
        } account.`;
    }
    tools.push(tool);
  }

  logger.info(
    `[secretary] ${tools.length} tools for [${active.join(",")}] (${
      tools.filter((t) => t.kind === "write_external").length
    } write)`,
  );
  return tools;
}
