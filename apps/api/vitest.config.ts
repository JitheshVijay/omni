import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs before each test file's imports, so @omni/env-config sees a
    // valid environment and @omni/sdk opens a throwaway database.
    setupFiles: ["./vitest.setup.ts"],
  },
});
