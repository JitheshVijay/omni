import { defineConfig, devices } from "@playwright/test";

// Two projects:
//   api — headless HTTP integration suite (the `request` fixture, no browser).
//   web — real Chromium E2E that drives the built UI at :5175 through actual
//         user workflows. Both assume the dev servers are already running
//         (API 4100, web 5175); start them with `npm run dev`.
//
// Run all:   npx playwright test
// API only:  npx playwright test --project=api
// Web only:  npx playwright test --project=web
export default defineConfig({
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  projects: [
    {
      name: "api",
      testDir: "./tests/api",
      use: { baseURL: process.env.API_URL || "http://localhost:4100" },
    },
    {
      name: "web",
      testDir: "./tests/e2e",
      use: {
        baseURL: process.env.WEB_URL || "http://localhost:5175",
        ...devices["Desktop Chrome"],
        // The generator workflows can take a while to stream a first artifact.
        actionTimeout: 30_000,
        navigationTimeout: 30_000,
        trace: "retain-on-failure",
      },
    },
  ],
});
