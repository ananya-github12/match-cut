import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/api/**/*.test.ts",
      "apps/worker/**/*.test.ts",
      "tests/**/*.test.ts",
      "evals/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "tests/**/*.int.test.ts"],
    // Every test runs in mock mode, with no API keys.
    env: { PROVIDER: "mock", DEV_API_TOKEN: "test-token" },
  },
});
