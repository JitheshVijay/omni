// Connector agent tools: the user's connected Composio actions for ALL active
// toolkits (Slack, Notion, GitHub, Linear, Google Drive/Sheets/Docs, Airtable,
// HubSpot, X, …), wrapped as AgentTool so the orchestrator treats them the same
// as native tools. READ actions (search/list/get/read) run immediately; WRITE
// actions (send/create/delete/update/…) are kind "write_external", so the
// orchestrator suspends for a confirmation card before running them — nothing is
// sent, created, or changed in a connected app without explicit confirmation.
//
// This GENERALIZES getSecretaryTools (Gmail/Calendar only) to every connected
// toolkit and SUPERSEDES it for the agent: the integrator should splice
// getConnectorTools INSTEAD OF getSecretaryTools to avoid duplicate gmail/
// calendar tools (Gmail/Calendar are in the connector catalog, so an active
// Secretary connection surfaces here too).
//
// Returns [] when Composio is unconfigured or the user has no ACTIVE connection,
// so the agent simply gains no connector tools rather than erroring.

import { logger } from "@omni/sdk";
import {
  composioEnabled,
  composioToolsForUser,
  composioToolKind,
  describeComposioAction,
  executeComposioTool,
} from "../../lib/composio.js";
import { activeToolkits, getConnector } from "../../lib/connectors.js";
import type { AgentTool, ToolResult } from "./types.js";

interface OpenAIFnTool {
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** Friendly app name for a Composio slug, from the catalog or the slug prefix. */
function appNameForSlug(slug: string): string {
  const toolkit = (slug.split("_")[0] ?? "").toLowerCase();
  const meta = getConnector(toolkit);
  if (meta) return meta.name;
  return toolkit ? toolkit.charAt(0).toUpperCase() + toolkit.slice(1) : "the connected app";
}

/**
 * Every connected toolkit's Composio actions as AgentTools. Empty when Composio
 * is off or nothing is actively connected. Never throws.
 */
export async function getConnectorTools(userId: string): Promise<AgentTool[]> {
  if (!composioEnabled()) return [];

  const active = activeToolkits(userId);
  if (active.length === 0) return [];

  let specs: OpenAIFnTool[];
  try {
    specs = (await composioToolsForUser(userId, active)) as OpenAIFnTool[];
  } catch (err) {
    logger.warn(`[connectors] tools fetch failed: ${(err as Error)?.message}`);
    return [];
  }

  const tools: AgentTool[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    const slug = spec.function?.name; // UPPERCASE Composio slug, e.g. SLACK_SEND_MESSAGE
    if (!slug) continue;
    const name = slug.toLowerCase(); // the model addresses tools lowercased
    if (seen.has(name)) continue; // dedup across toolkits (defensive)
    seen.add(name);

    const parameters =
      spec.function?.parameters && typeof spec.function.parameters === "object"
        ? spec.function.parameters
        : { type: "object", properties: {}, additionalProperties: true };
    const isRead = composioToolKind(slug) === "read";
    const label = describeComposioAction(slug);
    // Execute the original UPPERCASE slug even though the model uses lowercase.
    const captureSlug = slug;

    const tool: AgentTool = {
      name,
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
      const appName = appNameForSlug(captureSlug);
      tool.describe = async () =>
        `${label}. Review the details below before confirming — this will run against your connected ${appName} account.`;
    }
    tools.push(tool);
  }

  logger.info(
    `[connectors] ${tools.length} tools for [${active.join(",")}] (${
      tools.filter((t) => t.kind === "write_external").length
    } write)`,
  );
  return tools;
}
