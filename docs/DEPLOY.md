# Deploying Match Cut

The web app runs on **Vercel**. The API, the worker, Postgres and Redis run on a host for
long-lived processes; this guide uses **Railway**, with notes for **Fly.io**. Nothing here is
created automatically: each step is one you (or Claude, with your go-ahead) run.

```
browser ── Vercel (Next.js + /api/mc proxy) ──HTTPS + token──▶ API ──▶ Postgres
                                                               │  └──▶ Redis ◀── worker ──▶ Gemini
                                                               └──▶ YouTube Data API
```

The browser only ever talks to Vercel. The proxy adds the API token server-side and gives each
visitor an anonymous ID, so Gemini and YouTube keys live only on the API and worker.

## 0. Before you start

- The code in a GitHub repository (Railway and Vercel deploy from it).
- Accounts: Vercel, and Railway (or Fly.io). Both need a payment method for always-on services.
- Decide the mode:
  - **Demo, no model cost:** `PROVIDER=mock`. Everything works with recorded fixtures.
  - **Real analysis:** `PROVIDER=gemini` with a **paid** Gemini key (the free tier can't use the
    Pro-tier model and caps YouTube input at 8 hours a day) and a YouTube Data API key.
- Generate two secrets and keep them in a password manager:

  ```bash
  openssl rand -base64 32
  ```

  Run it twice: one value is `DEV_API_TOKEN` (shared by the proxy and the API), the other is
  `GOAL_ENCRYPTION_KEY` (encrypts goal text at rest; losing it makes stored goals unreadable).

## 1. Check the production image locally

```bash
pnpm services:up
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d --wait api worker
curl -s localhost:4200/v1/health
docker compose -f docker-compose.yml -f docker-compose.prod.yml rm -sf api worker
```

## 2. Railway: database, cache, API, worker

1. Create a project. Add a **PostgreSQL** database and a **Redis** database.
2. Redis must not evict keys (BullMQ requirement). Set `maxmemory-policy` to `noeviction` if the
   default differs.
3. Add a service from the GitHub repo for the **API**. It builds the root `Dockerfile`.
   Variables:

   | Variable | Value |
   | --- | --- |
   | `APP` | `api` |
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | reference the Postgres service's URL |
   | `REDIS_URL` | reference the Redis service's URL |
   | `DEV_API_TOKEN` | secret 1 |
   | `GOAL_ENCRYPTION_KEY` | secret 2 |
   | `PROVIDER` | `mock` or `gemini` |
   | `GEMINI_API_KEY`, `YOUTUBE_DATA_API_KEY` | only for `gemini` |
   | `GEMINI_MODEL_STANDARD`, `GEMINI_MODEL_DEEP`, `GEMINI_MODEL_FALLBACK` | see `.env.example` |
   | `DAILY_SPEND_CAP_USD` | start low, e.g. `2` |
   | `RATE_ORG_PER_DAY` | for a public demo, e.g. `200` (all visitors share one org) |
   | `WEB_ORIGIN` | your Vercel URL |

   Give it a public domain and set the health check path to `/v1/health`. The API runs database
   migrations on start. The host's `PORT` is used automatically.
4. Add a second service from the same repo for the **worker**: same variables, but `APP=worker`,
   and no public domain.
5. Check: `https://<api-domain>/v1/health` shows `database`, `cache` and `gemini` (or `mock`) as ok.

**Fly.io instead:** deploy the same image twice (`APP=api` with an HTTP service on the internal
port from `PORT`, `APP=worker` with no service), attach Fly Postgres or another managed Postgres,
and use a Redis provider that supports `noeviction` (for example Upstash with eviction off).

## 3. Vercel: the web app

1. Import the GitHub repo. Set **Root Directory** to `apps/web`; framework Next.js. Vercel installs
   from the workspace root with pnpm.
2. Environment variables (server-side only; never prefix them with `NEXT_PUBLIC_`):

   | Variable | Value |
   | --- | --- |
   | `MATCH_CUT_API_URL` | `https://<api-domain>` |
   | `MATCH_CUT_API_TOKEN` | secret 1 (same as the API's `DEV_API_TOKEN`) |

3. Deploy, then set the API's `WEB_ORIGIN` to the Vercel URL.
4. Event streams run in the proxy function for up to 300 seconds (`maxDuration`); your Vercel plan
   may cap this lower. When a stream ends early, the app falls back to polling, so results still
   arrive.

## 4. After deploying

- Open the site, paste a link, and run one brief end to end.
- Watch the worker logs for `"level":"alert"` lines; run the ops report from a machine that can
  reach the database: `DATABASE_URL=... REDIS_URL=... pnpm ops:report`.
- In Google Cloud, restrict the YouTube Data API key to that API, and set a budget alert on the
  Gemini project. Rotate keys every 90 days (PRD).

## What this deployment is, and isn't

- **Auth is a stand-in.** The proxy and API share one token; each visitor is an anonymous ID in an
  HTTP-only cookie. Rate limits are per visitor plus the org-wide cap; the daily spend cap is the
  hard stop. Integrating with Cardboard replaces this with real sessions.
- The Director is a stub: "Send to Director" posts to the chat and edits nothing.
- The image runs TypeScript with `tsx` (no build step) and is about 820 MB. A compiled build would
  be smaller and start faster; worth doing before real traffic.
