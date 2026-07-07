import { test, expect } from "@playwright/test";
import { capture } from "./_setup";

// The flagship generator, driven through the UI. Proves the "empty document"
// fix (reasoning:{enabled:false}) holds end-to-end: a prompt yields a real
// self-contained app that navigates to the viewer with a live preview iframe.
test("ai developer: prompt -> generated app -> viewer with preview", async ({ page }) => {
  test.setTimeout(150_000);
  const cap = capture(page);
  await page.goto("/tools/apps", { waitUntil: "domcontentloaded" });

  await expect(page.locator("h1").filter({ hasText: /Build an app with AI/i })).toBeVisible();

  const prompt = page.getByPlaceholder(/pomodoro/i);
  await expect(prompt).toBeVisible();
  await prompt.fill(
    "A single button labelled Joke that shows a random programming joke from a small hardcoded list when clicked.",
  );

  await page.getByRole("button", { name: "Generate app" }).click();

  // A live-preview iframe appears while HTML streams in.
  await expect(page.locator('iframe[title="Live preview"]')).toBeVisible({ timeout: 45_000 });

  // On the terminal artifact event the app navigates to the viewer.
  await expect(page).toHaveURL(/\/tools\/apps\/[0-9a-f-]{8,}/i, { timeout: 120_000 });

  // The viewer has Preview/Code tabs and renders the app in an iframe.
  await expect(page.getByRole("button", { name: "Code" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview" })).toBeVisible();
  await expect(page.locator("iframe").first()).toBeVisible();

  expect(cap.pageErrors, cap.pageErrors.map((e) => e.message).join("\n")).toHaveLength(0);
});
