import { defineConfig } from "@playwright/test";

// API-only integration suite: uses the `request` fixture, no browser.
export default defineConfig({
  testDir: "./tests/api",
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.API_URL || "http://localhost:4100",
  },
});
