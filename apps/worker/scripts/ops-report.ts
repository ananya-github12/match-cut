/**
 * Prints the PRD's dashboard signals from the briefs table: pnpm ops:report
 * Read-only. Reads Postgres and the spend counter in Redis.
 */
import { loadEnv } from "@match-cut/core";
import {
  computeSignals,
  connectPostgres,
  goalKeyFrom,
  previousKeysFrom,
  PgBriefStore,
  RedisKV,
  SafeKV,
  SpendTracker,
} from "@match-cut/infra";
import { Redis } from "ioredis";

const env = loadEnv();
const { sql, db } = connectPostgres(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
redis.on("error", () => {});
const store = new PgBriefStore(
  db,
  goalKeyFrom(env.GOAL_ENCRYPTION_KEY, env.DEV_API_TOKEN),
  previousKeysFrom(env.GOAL_ENCRYPTION_KEY_PREVIOUS),
);
const spend = new SpendTracker(
  new SafeKV(new RedisKV(redis, `${env.REDIS_NAMESPACE}:`), () => {}),
  {
    capUsd: env.DAILY_SPEND_CAP_USD,
  },
);

const rows = await store.listUpdatedSince(new Date(Date.now() - 15 * 86400_000));
const signals = computeSignals({
  rows,
  now: Date.now(),
  spendTodayUsd: await spend.today(),
  spendCapUsd: env.DAILY_SPEND_CAP_USD,
});
const fmt = (name: string, v: number | null) =>
  v === null
    ? "n/a"
    : name.endsWith("_ms_up_to_3min")
      ? `${Math.round(v)} ms`
      : name === "abuse_accounts"
        ? String(v)
        : name.endsWith("_wow")
          ? `${v.toFixed(1)}x`
          : `${(v * 100).toFixed(1)}%`;
console.table(
  signals.map((s) => ({
    signal: s.name,
    window: s.window,
    value: fmt(s.name, s.value),
    threshold: s.name.endsWith("_ms_up_to_3min")
      ? `${s.threshold} ms`
      : s.name === "abuse_accounts"
        ? `${s.threshold}x typical`
        : s.name.endsWith("_wow")
          ? "2x"
          : `${s.threshold * 100}%`,
    sample: s.sample,
    alert: s.alert ? "ALERT" : "",
    detail: s.detail ?? "",
  })),
);
console.log(`${rows.length} briefs updated in the last 15 days.`);
await sql.end({ timeout: 2 });
redis.disconnect();
