#!/bin/sh
# Runs every check CI runs. All tests use PROVIDER=mock; no API keys needed.
set -e
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
# Integration tests need Postgres and Redis (docker compose up -d --wait).
pnpm test:int
# Frontend acceptance tests (Playwright, full stack in mock mode). First run: pnpm --filter @match-cut/web exec playwright install chromium
pnpm test:e2e
