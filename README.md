# Match Cut

Turns a public YouTube reference video into an edit prompt for Cardboard's AI Director. It also builds **playbooks**: give it a channel, and it finds which of the channel's Shorts broke out, watches them and typical ones, and turns the edit choices that set the breakouts apart into rules you can apply to your own video or save as a skill.

Specs: [docs/PRD.md](docs/PRD.md) (v1, briefs) and [docs/PRD-playbooks.md](docs/PRD-playbooks.md) (MCP tool, shot lists, playbooks and skills). Working brief for Claude Code: [CLAUDE.md](CLAUDE.md).

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

The API serves a remote MCP server at `/mcp` with these tools:

- briefs: `analyze_reference`, `get_brief`, `regenerate_prompt` and `shot_list` (what to film);
- playbooks and skills: `build_playbook`, `get_playbook`, `apply_playbook`, `save_skill` and `list_skills`.

With Cardboard's connector in the same chat, the assistant can turn a YouTube link, or a channel's playbook, into an edit of your own footage.

1. Generate a key and add it to the API's `MCP_API_KEYS` (comma-separated; each key is its own user):

   ```sh
   openssl rand -hex 24
   ```

2. In Claude: Settings → Connectors → Add custom connector. URL: `https://<api-domain>/mcp`. Under request headers, add `Authorization: Bearer <your key>`. The server must be reachable on port 443.
3. Also connect Cardboard (Claude's connector directory), then ask: "Make my clips look like this Short: <link>".

Locally: `curl -s localhost:4000/mcp` answers 405 (POST only); `tests/mcp.test.ts` drives every tool with the official MCP client.

## Playbooks and saved skills

In the web app, open **Playbooks** (`/playbooks`), paste a channel (`@handle`, channel link or one of its video links) and build. The page streams progress (channel, stats, scoring, watching N of M, comparing, writing), then shows:

- a scatter of the channel's Shorts by outlier score;
- rules with evidence ("4 of 5 breakouts · 1 of 5 typical") and confidence;
- the channel's house style, and what the edit doesn't explain;
- example clips that open at the moment;
- an apply panel that writes a Cardboard prompt and shot list for your goal.

**Save as skill** keeps the rules; **Skills** (`/skills`) lists them and applies them without watching anything again.

Evidence, confidence and examples come from code; the model writes only the words, and every playbook passes a faithfulness check before it's shown.

- Mock channels: `@mockgolden01` to `@mockgolden10` (each with a planted edit pattern), `@mocktiny` (too little data), `@mockflat` (no breakouts), `@mockmixed`, `@mockhidden`, `@mocknew` (warnings), `@mockgone` (not found), `@mockdown` (YouTube unavailable). Specs: `packages/providers/src/youtube/mock-channels.ts`.
- Real channels need `PROVIDER=gemini` and both keys. A playbook watches up to 10 Shorts: about 22 Gemini calls, cached for 24 hours across users. Each user can build 5 playbooks a day (`RATE_PLAYBOOKS_PER_DAY`).
- Endpoints:
  - `POST /v1/playbooks`, then `GET /v1/playbooks/{id}` and `/events`; `POST /v1/playbooks/{id}/apply`; `DELETE /v1/playbooks/{id}`.
  - `POST /v1/skills`, `GET /v1/skills`, `GET /v1/skills/{id}`, `POST /v1/skills/{id}/apply`, `DELETE /v1/skills/{id}`.

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

A playbook (mock channel), then apply it:

```sh
curl -s -H "Authorization: Bearer dev-token-change-me" -H "content-type: application/json" \
  -d '{"source":{"channel":"@mockgolden01"}}' localhost:4000/v1/playbooks
curl -s -H "Authorization: Bearer dev-token-change-me" -H "content-type: application/json" \
  -d '{"goal":"a 30-second video about my coffee cart","target":{"format":"9:16","length_seconds":30}}' \
  localhost:4000/v1/playbooks/<id>/apply
```

Mock video IDs for every precheck case live in `packages/providers/src/youtube/mock.ts`; failure triggers (`mockFailP1a`, a goal containing `mockFailP2a`, `mockSlow001`) in `packages/providers/src/analyzer/mock.ts`.

## Layout

| Path                                 | What                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`                      | Zod schemas, env, errors, URL and channel parsers, versioned prompts and schemas, playbook scoring, comparison and checks |
| `packages/providers`                 | Gemini and mock analyzers, YouTube video and channel lookups (real and mock)                                              |
| `packages/infra`                     | Postgres (Drizzle) and in-memory stores, Redis cache, queues, limits, serializers                                         |
| `apps/api`                           | Fastify API, SSE, rate limits, MCP server at `/mcp`                                                                       |
| `apps/worker`                        | BullMQ worker: brief pipeline and playbook pipeline                                                                       |
| `apps/web`                           | Next.js frontend: editor with AI Chat, playbook page, skills list                                                         |
| `evals`                              | Golden sets for briefs and playbooks, rubric, reports                                                                     |
| `tests`                              | Lifecycle, API, pipeline and MCP tests; integration tests against real Postgres and Redis                                 |
| `config/capability-manifest.v0.json` | Placeholder list of Cardboard operations                                                                                  |

## Evals (golden set)

```sh
pnpm eval                                   # smoke set, mock provider and judge (free, offline)
pnpm eval -- --gate                         # fail if any criterion drops below evals/baseline.smoke.json
pnpm eval -- --set golden --provider gemini --judge gemini --review --yes   # real run (paid)
```

Playbooks have their own set: `pnpm eval -- --set playbooks --review --gate` builds a playbook for each case in `evals/playbooks/cases.json` (10 golden mock channels with planted patterns, plus edge cases) and checks faithfulness, planted patterns, warnings and apply. Real channels run with `--provider gemini --yes` once someone picks them and writes their notes.

Cases live in `evals/golden/cases.json`; each needs a human-written reference in `evals/golden/references/<id>.json` (template: `_TEMPLATE.json`) before it runs. Rubric: `evals/RUBRIC.md`. Reports go to `evals/reports/` (git-ignored); `--review` adds the human review sheet.

## Ops

The worker logs one JSON line per job (`"msg":"job finished"`, never the goal text) and checks the PRD's alert signals every 5 minutes, logging `"level":"alert"` lines. `pnpm ops:report` prints the signals from the database.

## Deploy

Web on Vercel; API, worker, Postgres and Redis on Railway (or Fly.io). Step-by-step guide, variables and the local production check: [docs/DEPLOY.md](docs/DEPLOY.md).
