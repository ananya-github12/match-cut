# CLAUDE.md: Match Cut

This file briefs Claude Code on the Match Cut project. Read it fully at the start of every session.

## What we are building

Match Cut turns a public YouTube reference video into an edit prompt for Cardboard, an AI video editor. A user pastes a YouTube link and says what they are making; the backend has Gemini watch the video (picture and audio), produce a structured breakdown of how it is made, and write a ready-to-run prompt for Cardboard's AI Director.

The full spec is the PRD: `docs/PRD.md` (same content as `docs/Match-Cut-PRD.pdf`). The PRD is the source of truth. Before starting any milestone, read the PRD sections listed for it. If the PRD and this file disagree, the PRD wins; tell me about the conflict.

This is a portfolio build to share with the Cardboard team, so it runs standalone. Cardboard's real auth, AI Chat and Director are not available; we stub them behind clean interfaces.

## Decisions already made (do not reopen without asking)

- **YouTube only in v1.** Instagram and TikTok are out of scope.
- **Never download, store or re-host video.** Gemini reads the YouTube URL directly.
- **Two Gemini passes.** Pass 1 watches the video and returns a goal-independent breakdown. Pass 2 is text-only and writes the Cardboard prompt from the breakdown, the user's goal, format, length, language and the capability manifest. Pass 1 never sees the goal.
- **Asynchronous jobs.** `POST /v1/briefs` returns 202 with a job ID (or 200 on a full cache hit); clients stream stage events or poll.
- **Canonical URLs only.** The Gemini `fileUri` is always rebuilt from the parsed video ID. Never forward the user's raw URL anywhere.
- **Keys stay server-side.** No Gemini or YouTube Data API call from any client.
- **Structured output.** Both passes use JSON response schemas, then schema and semantic validation, with one repair call on failure.
- **The API contract, error codes, edge cases, caching, limits and frontend behavior are fixed in the PRD.** Implement them as written.

## Defaults for the PRD's open questions

Use these until I say otherwise, and keep each one configurable:

- Output language comes from the `output_language` field, default `en`.
- Models come from env vars. Default to a current Flash-tier Gemini model for `standard` and pass 2, a Pro-tier model for `deep`, with a fallback model. Check current model names in Google's docs; do not guess.
- Caps: 20-minute videos without a clip range, 10-minute clip ranges, as in the PRD.
- Briefs are stored per user.
- The capability manifest is a placeholder file we own (see below), clearly marked as such.

## Stack

- TypeScript everywhere, Node 20+, pnpm workspaces.
- API: Fastify. Worker: BullMQ on Redis. Database: Postgres with Drizzle ORM.
- Validation and shared types: Zod.
- Frontend: Next.js (App Router) with plain CSS or CSS modules.
- Tests: Vitest; Playwright for frontend flows.
- Local services: Docker Compose (Redis, Postgres).
- Gemini: use the official Google Gen AI SDK for JavaScript or the REST API. Before writing the integration, check current docs for the YouTube URL input, `videoMetadata` (start and end offsets, fps), media resolution, structured output and finish reasons. Parameter names change between versions.

If you think a different choice is clearly better, say why before switching.

## Repository layout

```
match-cut/
  CLAUDE.md
  docs/PRD.md, docs/Match-Cut-PRD.pdf
  docker-compose.yml
  .env.example
  config/capability-manifest.v0.json   placeholder list of Cardboard operations
  packages/core/        Zod schemas (API, breakdown, pass 2 output), error codes, YouTube URL parser, timecode utils, prompt templates (versioned)
  packages/providers/   VideoAnalyzer interface, GeminiProvider, MockProvider (fixture-based)
  apps/api/             Fastify routes, auth stub, rate limits, SSE
  apps/worker/          pipeline: precheck, pass 1, pass 2, validate and repair, save
  apps/web/             Next.js frontend
  evals/                golden-set runner and rubric scoring
```

## Environment variables

```
GEMINI_API_KEY=
YOUTUBE_DATA_API_KEY=
GEMINI_MODEL_STANDARD=
GEMINI_MODEL_DEEP=
GEMINI_MODEL_FALLBACK=
PROVIDER=gemini            # or "mock" for offline development and tests
DATABASE_URL=postgres://matchcut:matchcut@localhost:5432/matchcut
REDIS_URL=redis://localhost:6379
DEV_API_TOKEN=             # stands in for a Cardboard session
DAILY_SPEND_CAP_USD=5
```

`PROVIDER=mock` must make the whole system runnable with no API keys, using recorded fixtures. Every test runs in mock mode.

## Milestones

Work one milestone at a time. At the end of each, run the tests, summarize what changed, list anything that deviates from the PRD, and wait for my go-ahead.

**M0: Scaffold.** Workspaces, Docker Compose, env loading with validation, lint and format, Vitest, a health endpoint, CI script. Done when `pnpm dev` starts API, worker and web against local Redis and Postgres.

**M1: URL parsing and precheck.** PRD: "Backend: input validation and edge cases" (URL and source, Video state, Length and clip range). Build the parser in `packages/core` with a unit test for every row of the URL table. Add the YouTube Data API precheck and `GET /v1/videos/{id}` (preview endpoint added by the frontend section). Done when every URL and video-state case returns the PRD's code.

**M2: Jobs and API contract.** PRD: "Backend: API contract", "Backend: architecture and request flow". All endpoints, request and response shapes, statuses and stages, idempotency keys, SSE events, cancel and delete, auth stub. Use MockProvider. Done when the full job lifecycle works end to end in mock mode, including cache hits returning 200.

**M3: Gemini pass 1.** PRD: "Backend: Gemini integration" (request construction, pass 1 rules, breakdown schema, post-processing). System instruction and schema versioned in `packages/core`. Semantic checks and one repair call. Record real responses for 5 varied videos as fixtures. Done when pass 1 returns valid breakdowns for those 5 videos.

**M4: Pass 2, manifest and regenerate.** PRD: pass 2 rules, capability manifest, `regenerate` endpoint, `partial` status. Done when changing goal, format or length regenerates the prompt without re-running pass 1, and a pass 2 failure returns `partial` with the breakdown.

**M5: Reliability, caching and limits.** PRD: "Backend: error handling and failure modes", "Backend: performance, cost, caching and limits", "Backend: security, privacy and compliance". Retry budget, backoff, fallback model, timeouts, finish-reason handling, three cache layers, rate limits, spend cap, logging without goal text. Done when each failure row in the PRD's table has a test using MockProvider fault injection.

**M6: Frontend.** PRD: "Frontend requirements", all subsections. Input panel, preview, progress with stages, result view with prompt first, beat timeline seeking the embedded player, breakdown, every error and warning message as written, actions, analytics events (log to console in dev). Done when the frontend acceptance checklist passes in Playwright against mock mode.

**M7: Evals and observability.** PRD: "Backend: observability and quality evaluation". Golden-set runner with rubric scoring and a report. Start with 10 videos; structure it to grow to 50. Per-job metrics logged as in the PRD.

**M8: Deploy.** Frontend on Vercel; API, worker, Redis and Postgres on a host that runs long-lived processes (for example Railway or Fly.io). Document the steps in `README.md`. Ask me before creating any cloud resources.

## Working rules

- Ask before changing the API contract, error codes, schemas or any decision listed above.
- Never commit secrets. Keep `.env.example` current.
- Real Gemini calls cost money: use mock mode by default and tell me before running anything that calls the real API more than a few times.
- Keep prompts and schemas in versioned files; bump the version when their wording changes, because cache keys depend on it.
- Write tests alongside code, not after. Every PRD edge-case row should map to a test.
- Keep user-facing copy exactly as the PRD's message tables say.
- If something in the PRD is ambiguous or impossible with the current Gemini API, stop and tell me rather than inventing behavior.

## First prompt to run

> Read CLAUDE.md and docs/PRD.md. Summarize the plan in 10 bullet points, list any questions or conflicts you see, then start M0.
