import { BRIEF_QUEUE, loadEnv, modelNames, useYouTubeLookup } from "@match-cut/core";
import {
  computeSignals,
  connectPostgres,
  defaultRules,
  goalKeyFrom,
  previousKeysFrom,
  PgBriefStore,
  RateLimiter,
  RedisBriefEvents,
  RedisKV,
  SafeKV,
  SpendTracker,
  type JobData,
} from "@match-cut/infra";
import { MockVideoLookup, YouTubeDataApiLookup } from "@match-cut/providers";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { runJob, type PipelineDeps } from "./pipeline.js";
import { buildAnalyzer, pipelineSettings } from "./setup.js";

const env = loadEnv();
const models = modelNames(env);

// BullMQ needs maxRetriesPerRequest: null on worker connections.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
const sub = new Redis(env.REDIS_URL);
let warned = false;
connection.on("error", (err) => {
  if (!warned) {
    console.error(
      `[worker] Redis unreachable at ${env.REDIS_URL} (${(err as NodeJS.ErrnoException).code ?? err.message}). Is "pnpm services:up" running?`,
    );
  }
  warned = true;
});
for (const r of [redis, sub]) r.on("error", () => {});
connection.on("ready", () => {
  warned = false;
  console.log(
    `[worker] connected to Redis, consuming "${BRIEF_QUEUE}" (provider: ${env.PROVIDER})`,
  );
});

if (!env.GOAL_ENCRYPTION_KEY) {
  console.warn(
    "[worker] GOAL_ENCRYPTION_KEY not set; using a development key. Set it before deploying.",
  );
}
const { sql, db } = connectPostgres(env.DATABASE_URL);
const store = new PgBriefStore(
  db,
  goalKeyFrom(env.GOAL_ENCRYPTION_KEY, env.DEV_API_TOKEN),
  previousKeysFrom(env.GOAL_ENCRYPTION_KEY_PREVIOUS),
);
const kv = new SafeKV(new RedisKV(redis, `${env.REDIS_NAMESPACE}:`));
const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ level: "info", src: "worker", msg, ...extra }));

const spend = new SpendTracker(kv, { capUsd: env.DAILY_SPEND_CAP_USD });

const deps: PipelineDeps = {
  ...pipelineSettings(env),
  store,
  kv,
  events: new RedisBriefEvents(redis, sub, `${env.REDIS_NAMESPACE}:`),
  analyzer: buildAnalyzer(env, models),
  models,
  // Uncached on purpose: re-classifies a video that became private or deleted mid-job.
  lookup: !useYouTubeLookup(env)
    ? new MockVideoLookup()
    : new YouTubeDataApiLookup({ apiKey: env.YOUTUBE_DATA_API_KEY! }),
  spend,
  limiter: new RateLimiter(
    kv,
    defaultRules({
      userPerHour: env.RATE_USER_PER_HOUR,
      userPerDay: env.RATE_USER_PER_DAY,
      regeneratePerHour: env.RATE_REGENERATE_PER_HOUR,
      orgPerDay: env.RATE_ORG_PER_DAY,
    }),
  ),
  log,
};

const worker = new Worker<JobData>(BRIEF_QUEUE, (job) => runJob(job.data, deps), {
  connection,
  prefix: `${env.REDIS_NAMESPACE}-bull`,
  concurrency: env.WORKER_CONCURRENCY,
  // PRD "Worker crashes mid-job": heartbeat missing for 30 s -> requeue once; the pipeline
  // resumes from the last finished pass.
  lockDuration: 30_000,
  stalledInterval: 30_000,
  maxStalledCount: 1,
});
worker.on("failed", (job, err) => console.error(`[worker] job ${job?.id} crashed: ${err.message}`));

// PRD retention: briefs (and their goal text) are deleted after BRIEF_RETENTION_DAYS.
async function retention() {
  try {
    const cutoff = new Date(Date.now() - env.BRIEF_RETENTION_DAYS * 86400_000);
    const n = await store.deleteOlderThan(cutoff);
    if (n > 0) log("retention: deleted old briefs", { count: n });
  } catch (e) {
    console.warn(`[worker] retention run failed: ${(e as Error).message}`);
  }
}
void retention();
const retentionTimer = setInterval(retention, 6 * 3600_000);

// PRD "Dashboards and alerts": compute the signals every 5 minutes and log ALERT lines.
// A short lock keeps several workers from reporting the same window twice.
async function opsCheck() {
  try {
    if (!(await kv.setIfAbsent("ops-check-lock", "1", 240))) return;
    const rows = await store.listUpdatedSince(new Date(Date.now() - 15 * 86400_000));
    const signals = computeSignals({
      rows,
      now: Date.now(),
      spendTodayUsd: await spend.today(),
      spendCapUsd: env.DAILY_SPEND_CAP_USD,
    });
    for (const sig of signals.filter((x) => x.alert)) {
      console.warn(JSON.stringify({ level: "alert", src: "ops", ...sig }));
    }
    log("ops signals", {
      signals: Object.fromEntries(
        signals.map((x) => [x.name, { value: x.value, sample: x.sample, alert: x.alert }]),
      ),
    });
  } catch (e) {
    console.warn(`[worker] ops check failed: ${(e as Error).message}`);
  }
}
const opsTimer = setInterval(opsCheck, 5 * 60_000);

const shutdown = async () => {
  clearInterval(retentionTimer);
  clearInterval(opsTimer);
  await worker.close();
  await sql.end({ timeout: 2 });
  for (const r of [connection, redis, sub]) r.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
