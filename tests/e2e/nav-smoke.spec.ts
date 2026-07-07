import { test, expect } from "@playwright/test";
import { ROUTES, capture } from "./_setup";

// Walk every top-level route in a real browser. A route "works" when its
// first-render heading is visible AND the page threw no uncaught exceptions.
// Console errors are reported but not fatal (fail-soft pages log network 4xx).
for (const route of ROUTES) {
  test(`nav: ${route.label} (${route.path}) renders without crashing`, async ({ page }) => {
    const cap = capture(page);
    await page.goto(route.path, { waitUntil: "domcontentloaded" });

    await expect(
      page.locator("h1").filter({ hasText: route.heading }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // The sidebar rail must be present on every route (shell mounted).
    await expect(page.getByRole("link", { name: "Omni home" })).toBeVisible();

    if (cap.consoleErrors.length) {
      console.log(`  [${route.path}] console.error x${cap.consoleErrors.length}: ${cap.consoleErrors[0]?.slice(0, 120)}`);
    }
    expect(cap.pageErrors, cap.pageErrors.map((e) => e.message).join("\n")).toHaveLength(0);
  });
}
