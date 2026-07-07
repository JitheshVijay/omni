import type { Page } from "@playwright/test";

// Every top-level route + a stable, first-render <h1> substring that proves the
// page mounted (headings are static, never data-gated — the map was derived
// from source). Used by the nav smoke to walk the whole app.
export const ROUTES: Array<{ path: string; heading: RegExp; label: string }> = [
  { path: "/chat", heading: /What can I help you/i, label: "Chat" },
  { path: "/hubs", heading: /^Hubs$/, label: "Hubs" },
  { path: "/drive", heading: /^Drive$/, label: "Drive" },
  { path: "/library", heading: /^Library$/, label: "Library" },
  { path: "/agent", heading: /Super Agent/i, label: "Agent" },
  { path: "/research", heading: /Research anything/i, label: "Research" },
  { path: "/workflows", heading: /What would you like to automate/i, label: "Flows" },
  { path: "/secretary", heading: /^Secretary$/, label: "Secretary" },
  { path: "/tools", heading: /What would you like to make/i, label: "Tools" },
  { path: "/skills", heading: /Skills are reusable AI tools/i, label: "Skills" },
  { path: "/agentbase", heading: /Custom dashboards, CRM/i, label: "Systems" },
  { path: "/connectors", heading: /Connect your apps/i, label: "Connect" },
  { path: "/tools/apps", heading: /Build an app with AI/i, label: "AI Developer" },
  { path: "/tools/images", heading: /Create with Image Studio/i, label: "Image Studio" },
  { path: "/tools/design", heading: /What would you like to design/i, label: "Design Studio" },
  { path: "/settings", heading: /^Settings$/, label: "Settings" },
];

export interface Captured {
  pageErrors: Error[];
  consoleErrors: string[];
}

// Attach listeners for uncaught exceptions (fatal — a crashed page) and
// console.error (informational — some are fail-soft network noise). Call before
// navigating.
export function capture(page: Page): Captured {
  const c: Captured = { pageErrors: [], consoleErrors: [] };
  page.on("pageerror", (e) => c.pageErrors.push(e));
  page.on("console", (m) => {
    if (m.type() === "error") c.consoleErrors.push(m.text());
  });
  return c;
}
