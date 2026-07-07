import { test, expect } from "@playwright/test";
import { capture } from "./_setup";

// The connector store (Composio) + MCP host surface, driven through the UI.
// Without COMPOSIO_API_KEY it shows a fail-soft preview: the full catalog with
// disabled Connect buttons and an "aren't configured yet" banner.
test("connectors: catalog preview, fail-soft banner, category filters", async ({ page }) => {
  const cap = capture(page);
  await page.goto("/connectors", { waitUntil: "domcontentloaded" });

  await expect(page.locator("h1").filter({ hasText: /Connect your apps/i })).toBeVisible();

  // Fail-soft banner appears once /api/connectors resolves unconfigured.
  await expect(page.getByText(/Connectors aren't configured yet/i)).toBeVisible({ timeout: 10_000 });

  // Category filter chips.
  for (const chip of ["All", "Communication", "Dev", "CRM & Sales"]) {
    await expect(page.getByRole("button", { name: chip, exact: true })).toBeVisible();
  }

  // Search box + a full catalog of app cards (each card has a Connect button).
  await expect(page.getByPlaceholder(/Search apps/i)).toBeVisible();
  const connectButtons = page.getByRole("button", { name: "Connect", exact: true });
  expect(await connectButtons.count()).toBeGreaterThanOrEqual(18);

  // A few expected apps are present.
  for (const app of ["Slack", "Notion", "GitHub"]) {
    await expect(page.getByRole("heading", { name: app, exact: true })).toBeVisible();
  }

  expect(cap.pageErrors, cap.pageErrors.map((e) => e.message).join("\n")).toHaveLength(0);
});

// The MCP host section reflects the live /api/mcp/servers status. With a local
// mcp.json present the "everything" reference server is connected.
test("connectors: MCP host section reflects connected servers", async ({ page }) => {
  await page.goto("/connectors", { waitUntil: "domcontentloaded" });
  // Soft check — only assert if an MCP server is configured in this environment.
  const everything = page.getByText(/everything/i).first();
  if (await everything.count().catch(() => 0)) {
    await expect(everything).toBeVisible({ timeout: 5_000 });
  }
});
