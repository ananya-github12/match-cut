/**
 * Frontend acceptance tests (PRD "Frontend acceptance criteria") against the full stack in mock
 * mode: API, worker and web on their own ports. Needs Postgres and Redis (pnpm services:up).
 */
import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = 3100;
const API_PORT = 4100;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    permissions: ["clipboard-read", "clipboard-write"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "corepack pnpm dev",
    cwd: "../..",
    url: `http://localhost:${WEB_PORT}`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      PROVIDER: "mock",
      // Separate Redis keys, channels and queue from dev data.
      REDIS_NAMESPACE: "mc-e2e",
      API_PORT: String(API_PORT),
      WEB_PORT: String(WEB_PORT),
      WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
      MOCK_WATCH_DELAY_MS: "1500",
      MOCK_WRITE_DELAY_MS: "1000",
      RATE_USER_PER_HOUR: "100000",
      RATE_USER_PER_DAY: "100000",
      RATE_ORG_PER_DAY: "100000",
      RATE_REGENERATE_PER_HOUR: "100000",
      DAILY_SPEND_CAP_USD: "100000",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
