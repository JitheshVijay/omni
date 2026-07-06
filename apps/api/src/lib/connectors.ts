// Connector catalog — the browsable store of Composio-managed apps Omni can
// connect (Slack, Notion, GitHub, Linear, Google Drive/Sheets/Docs, Airtable,
// HubSpot, X, Asana, Trello, Discord, Jira, …). This GENERALIZES the Secretary's
// two-toolkit setup: connectToolkit / connectionStatus / composioToolsForUser in
// lib/composio.ts already accept any toolkit slug, so a connector is just a
// catalog entry whose slug is fed through those same functions.
//
// Pure metadata + a DB read — no Composio calls here, so it is safe to import
// and evaluate even when COMPOSIO_API_KEY is unset. Connection state is read
// from the same `connections` table the Secretary uses (via listConnections).

import { listConnections } from "./composio.js";

export const CONNECTOR_CATEGORIES = [
  "Communication",
  "Docs & Notes",
  "Dev",
  "CRM & Sales",
  "Productivity",
  "Social",
] as const;

export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

export interface ConnectorMeta {
  /** Composio toolkit slug, lowercase (e.g. "slack", "googledrive"). */
  toolkit: string;
  /** Display name (e.g. "Google Drive"). */
  name: string;
  /** One-line description of what connecting the app unlocks. */
  description: string;
  category: ConnectorCategory;
  /** Optional icon hint (unused by the current UI, which draws a monogram). */
  icon?: string;
}

// ~23 apps across the six categories. Slugs are Composio toolkit slugs — the
// same value passed to connectToolkit/connectionStatus. Keep them lowercase and
// hyphen/underscore-free to match Composio's convention.
export const CONNECTOR_CATALOG: ConnectorMeta[] = [
  // ── Communication ──────────────────────────────────────────────────────────
  {
    toolkit: "slack",
    name: "Slack",
    description: "Send messages, read channels, and search your Slack workspace.",
    category: "Communication",
  },
  {
    toolkit: "discord",
    name: "Discord",
    description: "Post messages and manage servers and channels in Discord.",
    category: "Communication",
  },
  {
    toolkit: "gmail",
    name: "Gmail",
    description: "Read, search, draft, and send email from your inbox.",
    category: "Communication",
  },
  // ── Docs & Notes ────────────────────────────────────────────────────────────
  {
    toolkit: "notion",
    name: "Notion",
    description: "Read and write pages, databases, and notes in Notion.",
    category: "Docs & Notes",
  },
  {
    toolkit: "googledocs",
    name: "Google Docs",
    description: "Create, read, and edit documents in Google Docs.",
    category: "Docs & Notes",
  },
  {
    toolkit: "googledrive",
    name: "Google Drive",
    description: "Browse, search, and manage files across Google Drive.",
    category: "Docs & Notes",
  },
  {
    toolkit: "googlesheets",
    name: "Google Sheets",
    description: "Read and write spreadsheet data in Google Sheets.",
    category: "Docs & Notes",
  },
  {
    toolkit: "airtable",
    name: "Airtable",
    description: "Query and update records across your Airtable bases.",
    category: "Docs & Notes",
  },
  {
    toolkit: "confluence",
    name: "Confluence",
    description: "Read and write documentation pages and spaces in Confluence.",
    category: "Docs & Notes",
  },
  // ── Dev ─────────────────────────────────────────────────────────────────────
  {
    toolkit: "github",
    name: "GitHub",
    description: "Manage repositories, issues, and pull requests on GitHub.",
    category: "Dev",
  },
  {
    toolkit: "linear",
    name: "Linear",
    description: "Track issues, projects, and cycles in Linear.",
    category: "Dev",
  },
  {
    toolkit: "jira",
    name: "Jira",
    description: "Create and manage issues, boards, and sprints in Jira.",
    category: "Dev",
  },
  {
    toolkit: "gitlab",
    name: "GitLab",
    description: "Manage repos, issues, and merge requests in GitLab.",
    category: "Dev",
  },
  // ── CRM & Sales ─────────────────────────────────────────────────────────────
  {
    toolkit: "hubspot",
    name: "HubSpot",
    description: "Manage contacts, deals, and companies in HubSpot CRM.",
    category: "CRM & Sales",
  },
  {
    toolkit: "salesforce",
    name: "Salesforce",
    description: "Work with leads, opportunities, and accounts in Salesforce.",
    category: "CRM & Sales",
  },
  {
    toolkit: "pipedrive",
    name: "Pipedrive",
    description: "Track deals and contacts across your Pipedrive pipeline.",
    category: "CRM & Sales",
  },
  // ── Productivity ────────────────────────────────────────────────────────────
  {
    toolkit: "googlecalendar",
    name: "Google Calendar",
    description: "See your schedule and create or update calendar events.",
    category: "Productivity",
  },
  {
    toolkit: "asana",
    name: "Asana",
    description: "Manage tasks, projects, and workflows in Asana.",
    category: "Productivity",
  },
  {
    toolkit: "trello",
    name: "Trello",
    description: "Organize boards, lists, and cards in Trello.",
    category: "Productivity",
  },
  {
    toolkit: "clickup",
    name: "ClickUp",
    description: "Manage tasks, docs, and goals in ClickUp.",
    category: "Productivity",
  },
  // ── Social ──────────────────────────────────────────────────────────────────
  {
    toolkit: "twitter",
    name: "X (Twitter)",
    description: "Post, search, and read timelines on X (formerly Twitter).",
    category: "Social",
  },
  {
    toolkit: "linkedin",
    name: "LinkedIn",
    description: "Share posts and read your feed on LinkedIn.",
    category: "Social",
  },
  {
    toolkit: "reddit",
    name: "Reddit",
    description: "Browse, post, and search across subreddits on Reddit.",
    category: "Social",
  },
];

const BY_SLUG = new Map<string, ConnectorMeta>(
  CONNECTOR_CATALOG.map((c) => [c.toolkit, c]),
);

/** Catalog lookup by toolkit slug (case-insensitive). */
export function getConnector(toolkit: string): ConnectorMeta | undefined {
  return BY_SLUG.get(toolkit.toLowerCase());
}

/**
 * The toolkits the user currently has an ACTIVE connection for, read from the
 * shared `connections` table (source of truth the Secretary also uses). Empty
 * when nothing is connected. Never throws.
 */
export function activeToolkits(userId: string): string[] {
  try {
    return listConnections(userId)
      .filter((c) => c.status === "active")
      .map((c) => c.toolkit);
  } catch {
    return [];
  }
}
