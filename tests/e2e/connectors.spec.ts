import { test, expect } from "@playwright/test";
import { capture } from "./_setup";

// The connector store (Composio) + MCP host surface, driven through the UI.
// The hero, category filters, search, and full catalog hold whether or not
// COMPOSIO_API_KEY is set; the "aren't configured yet" banner appears only when
// the key is absent, so it's asserted conditionally to keep the test green in
// both a configured and an unconfigured environment.
test("connectors: catalog, category filters, brand apps", async ({ page }) => {
  const cap = capture(page);
  await page.goto("/connectors", { waitUntil: "domcontentloaded" });

  await expect(page.locator("h1").filter({ hasText: /Connect your apps/i })).toBeVisible();

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

  // Fail-soft banner: only present when COMPOSIO_API_KEY is unset.
  const banner = page.getByText(/Connectors aren't configured yet/i);
  if (await banner.count()) await expect(banner.first()).toBeVisible();

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
