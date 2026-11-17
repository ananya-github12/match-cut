import {
  DEFAULT_LIMITS,
  loadEnv,
  loadManifest,
  modelNames,
  useYouTubeLookup,
} from "@match-cut/core";
import {
  BullJobQueue,
  connectPostgres,
  defaultRules,
  goalKeyFrom,
  previousKeysFrom,
  PgBriefStore,
  RateLimiter,
  RedisBriefEvents,
  RedisKV,
  runMigrations,
  SafeKV,
  SpendTracker,
} from "@match-cut/infra";
import { CachedVideoLookup, MockVideoLookup, YouTubeDataApiLookup } from "@match-cut/providers";
import { buildAnalyzer, makeSyncRunner } from "@match-cut/worker/setup";
import { GoogleGenAI } from "@google/genai";
import { Redis } from "ioredis";
import { buildApp } from "./app.js";

const env = loadEnv();
const models = modelNames(env);

const { sql, db } = connectPostgres(env.DATABASE_URL);
const redisOpts = {
  maxRetriesPerRequest: 1,
  retryStrategy: (n: number) => Math.min(n * 500, 5000),
};
const redis = new Redis(env.REDIS_URL, redisOpts);
const sub = new Redis(env.REDIS_URL, redisOpts);
const bull = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
for (const r of [redis, sub, bull]) r.on("error", () => {}); // health reports it

try {
  await runMigrations(db);
} catch (e) {
  console.error(`[api] database migration failed: ${(e as Error).message}`);
}
if (!env.GOAL_ENCRYPTION_KEY) {
  console.warn(
    "[api] GOAL_ENCRYPTION_KEY not set; using a development key. Set it before deploying.",
  );
}

// PRD "Cache store down": every cache and coordination read/write degrades instead of failing.
const kv = new SafeKV(new RedisKV(redis, `${env.REDIS_NAMESPACE}:`));
const rawLookup = !useYouTubeLookup(env)
  ? new MockVideoLookup()
  : new YouTubeDataApiLookup({ apiKey: env.YOUTUBE_DATA_API_KEY! });
const limiter = new RateLimiter(
  kv,
  defaultRules({
    userPerHour: env.RATE_USER_PER_HOUR,
    userPerDay: env.RATE_USER_PER_DAY,
    regeneratePerHour: env.RATE_REGENERATE_PER_HOUR,
    orgPerDay: env.RATE_ORG_PER_DAY,
  }),
);
const spend = new SpendTracker(kv, { capUsd: env.DAILY_SPEND_CAP_USD });

const queue = new BullJobQueue(bull, `${env.REDIS_NAMESPACE}-bull`);
const gemini =
  env.PROVIDER === "gemini"
    ? new GoogleGenAI({
        apiKey: env.GEMINI_API_KEY!,
        httpOptions: { retryOptions: { attempts: 1 } },
      })
    : null;

const app = buildApp({
  logger: true,
  // Behind a host's proxy in production: trust X-Forwarded-* for client IPs in logs.
  trustProxy: env.NODE_ENV === "production",
  // PRD cache layer 1: precheck metadata for 6 hours.
  lookup: new CachedVideoLookup(rawLookup, kv),
  store: new PgBriefStore(
    db,
    goalKeyFrom(env.GOAL_ENCRYPTION_KEY, env.DEV_API_TOKEN),
    previousKeysFrom(env.GOAL_ENCRYPTION_KEY_PREVIOUS),
  ),
  kv,
  events: new RedisBriefEvents(redis, sub, `${env.REDIS_NAMESPACE}:`),
  queue,
  models,
  manifest: loadManifest(),
  devToken: env.DEV_API_TOKEN,
  region: env.YOUTUBE_REGION,
  limits: {
    ...DEFAULT_LIMITS,
    maxVideoSeconds: env.MAX_VIDEO_SECONDS,
    maxClipSeconds: env.MAX_CLIP_SECONDS,
  },
  limiter,
  spend,
  syncRun: makeSyncRunner({
    env,
    models,
    analyzer: buildAnalyzer(env, models),
    kv,
    lookup: rawLookup,
    spend,
    limiter,
  }),
  webOrigin: env.WEB_ORIGIN,
  health: {
    database: async () => {
      await sql`select 1`;
    },
    cache: async () => {
      await redis.ping();
    },
    // Model metadata lookup: free, and proves the key and model name work.
    gemini: async () => {
      if (!gemini) return "mock";
      await gemini.models.get({
        model: models.standard,
        config: { httpOptions: { timeout: 1500 } },
      });
      return "ok";
    },
  },
});

const shutdown = async () => {
  await app.close();
  await queue.queue.close();
  await Promise.allSettled([sql.end({ timeout: 2 })]);
  for (const r of [redis, sub, bull]) r.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// In production, hosts like Railway and Fly set PORT. In development PORT belongs to whatever
// launched the web app (a preview runner), so the API keeps API_PORT.
const port =
  env.NODE_ENV === "production" ? Number(process.env.PORT ?? env.API_PORT) : env.API_PORT;
await app.listen({ port, host: "0.0.0.0" });
