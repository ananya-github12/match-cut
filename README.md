# Match Cut

Turns a public YouTube reference video into an edit prompt for Cardboard's AI Director. Spec: [docs/PRD.md](docs/PRD.md). Working brief for Claude Code: [CLAUDE.md](CLAUDE.md).

## Prerequisites

- Node 20.12+ and pnpm (`corepack enable pnpm`, or `npm i -g pnpm`)
- Docker (Docker Desktop or OrbStack) for local Redis and Postgres

## Run locally

```sh
cp .env.example .env      # PROVIDER=mock needs no API keys
pnpm install
pnpm services:up          # Redis + Postgres via Docker Compose
pnpm dev                  # API :4000, worker, web :3000
```

`GET http://localhost:4000/v1/health` reports database, cache and Gemini status.

## Test locally with the real APIs

With `PROVIDER=gemini`, `GEMINI_API_KEY` and `YOUTUBE_DATA_API_KEY` in `.env`:

```sh
corepack pnpm local          # Postgres + Redis, then API, worker and web: real Gemini and YouTube
corepack pnpm local:hybrid   # real YouTube previews and player, mock analysis (no Gemini cost)
```

Open http://localhost:3000. `corepack pnpm check:setup --ping <link>` checks the keys first. Real runs are billed by Google; the daily cap is `DAILY_SPEND_CAP_USD` (default $5).

## Use Match Cut from Claude or ChatGPT (MCP)

The API serves a remote MCP server at `/mcp` with four tools: `analyze_reference`, `get_brief`, `regenerate_prompt` and `shot_list` (what to film). With Cardboard's connector in the same chat, the assistant can turn a YouTube link into an edit of your own footage.

1. Generate a key and add it to the API's `MCP_API_KEYS` (comma-separated; each key is its own user):

   ```sh
   openssl rand -hex 24
   ```

2. In Claude: Settings → Connectors → Add custom connector. URL: `https://<api-domain>/mcp`. Under request headers, add `Authorization: Bearer <your key>`. The server must be reachable on port 443.
3. Also connect Cardboard (Claude's connector directory), then ask: "Make my clips look like this Short: <link>".

Locally: `curl -s localhost:4000/mcp` answers 405 (POST only); `tests/mcp.test.ts` drives every tool with the official MCP client.

## Checks

```sh
pnpm ci         # install, format check, lint, typecheck, unit + integration tests
pnpm test       # unit and lifecycle tests, in memory, no Docker needed
pnpm test:int   # full lifecycle against real Postgres, Redis and BullMQ
pnpm test:e2e   # frontend acceptance tests in Playwright (starts API, worker and web in mock mode)
```

The web app runs at http://localhost:3000. Match Cut lives in the AI Chat panel: paste a YouTube link, use "Match a reference", type `/match`, ask the Director ("make it look like this video" plus a link), or open `/match?url=…`.

## Try the API (mock mode)

```sh
curl -s -H "Authorization: Bearer dev-token-change-me" -H "content-type: application/json" \
  -d '{"source":{"url":"https://youtu.be/mockShort01"},"goal":"A launch video for my app"}' \
  localhost:4000/v1/briefs
curl -sN -H "Authorization: Bearer dev-token-change-me" localhost:4000/v1/briefs/<id>/events
```

Mock video IDs for every precheck case live in `packages/providers/src/youtube/mock.ts`; failure triggers (`mockFailP1a`, a goal containing `mockFailP2a`, `mockSlow001`) in `packages/providers/src/analyzer/mock.ts`.

## Layout

| Path                                 | What                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `packages/core`                      | Zod schemas, env loading, shared constants (URL parser, prompts and errors land in M1 to M4) |
| `apps/api`                           | Fastify API                                                                                  |
| `apps/worker`                        | BullMQ worker running the analysis pipeline                                                  |
| `apps/web`                           | Next.js frontend                                                                             |
| `config/capability-manifest.v0.json` | Placeholder list of Cardboard operations                                                     |

## Evals (golden set)

```sh
pnpm eval                                   # smoke set, mock provider and judge (free, offline)
pnpm eval -- --gate                         # fail if any criterion drops below evals/baseline.smoke.json
pnpm eval -- --set golden --provider gemini --judge gemini --review --yes   # real run (paid)
```

Cases live in `evals/golden/cases.json`; each needs a human-written reference in `evals/golden/references/<id>.json` (template: `_TEMPLATE.json`) before it runs. Rubric: `evals/RUBRIC.md`. Reports go to `evals/reports/` (git-ignored); `--review` adds the human review sheet.

## Ops

The worker logs one JSON line per job (`"msg":"job finished"`, never the goal text) and checks the PRD's alert signals every 5 minutes, logging `"level":"alert"` lines. `pnpm ops:report` prints the signals from the database.

## Deploy

Web on Vercel; API, worker, Postgres and Redis on Railway (or Fly.io). Step-by-step guide, variables and the local production check: [docs/DEPLOY.md](docs/DEPLOY.md).
