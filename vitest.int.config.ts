import { defineConfig } from "vitest/config";

// Integration tests: need `pnpm services:up` (Postgres + Redis). Still mock provider, no keys.
export default defineConfig({
  test: {
    include: ["tests/**/*.int.test.ts"],
    env: { PROVIDER: "mock", DEV_API_TOKEN: "test-token" },
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
