import { test, expect } from "@playwright/test";
import { capture } from "./_setup";

// Full chat round-trip through the real UI: type in the composer, send, follow
// the navigation to the new thread, and assert a streamed assistant reply
// renders. Exercises SSE streaming end-to-end in the browser.
test("chat: compose -> new thread -> streamed assistant reply", async ({ page }) => {
  const cap = capture(page);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });

  const composer = page.getByPlaceholder(/Ask anything/i);
  await expect(composer).toBeVisible();
  await composer.fill('Respond with only the single word: pong');

  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeEnabled();
  await send.click();

  // Composer send POSTs a thread then navigates to /chat/:threadId.
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{8,}/i, { timeout: 15_000 });

  // The user's message bubble echoes what we typed.
  await expect(page.getByText("Respond with only the single word", { exact: false })).toBeVisible();

  // The assistant reply streams into .omni-prose (unique to assistant markdown).
  const reply = page.locator(".omni-prose").first();
  await expect(reply).toBeVisible({ timeout: 60_000 });
  await expect(reply).toContainText(/pong/i, { timeout: 60_000 });

  expect(cap.pageErrors, cap.pageErrors.map((e) => e.message).join("\n")).toHaveLength(0);
});
