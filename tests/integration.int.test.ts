/**
 * Full lifecycle against real Postgres, Redis and BullMQ (Docker). Run with `pnpm test:int`.
 * Uses its own Redis key prefix and queue name, and deletes what it creates.
 */
import { buildApp } from "@match-cut/api/app";
import { loadManifest, modelNames, parseEnv } from "@match-cut/core";
import {
  BullJobQueue,
  connectPostgres,
  goalKeyFrom,
  PgBriefStore,
  RedisBriefEvents,
  RedisKV,
  runMigrations,
  type JobData,
} from "@match-cut/infra";
import { MockAnalyzer, MockVideoLookup, MOCK_VIDEOS } from "@match-cut/providers";
import { runJob } from "@match-cut/worker/pipeline";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://matchcut:matchcut@localhost:5432/matchcut";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const AUTH = { authorization: "Bearer test-token" };
const prefix = `mc-test-${Date.now()}:`;

const { sql, db } = connectPostgres(DATABASE_URL);
const redis = new Redis(REDIS_URL);
const sub = new Redis(REDIS_URL);
const bull = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const goalKey = goalKeyFrom(undefined, "integration-test");
const store = new PgBriefStore(db, goalKey);
const kv = new RedisKV(redis, prefix);
const events = new RedisBriefEvents(redis, sub);
const queue = new BullJobQueue(bull);
const models = modelNames(parseEnv({ DEV_API_TOKEN: "x", PROVIDER: "mock" }));
const manifest = loadManifest();
const created: string[] = [];
let worker: Worker<JobData>;

const app = buildApp({
  health: { database: async () => {}, cache: async () => {}, gemini: async () => "mock" },
  lookup: new MockVideoLookup(),
  store,
  kv,
  events,
  queue,
  models,
  manifest,
  devToken: "test-token",
});

beforeAll(async () => {
  await runMigrations(db);
  worker = new Worker<JobData>(
    queue.queue.name,
    (job) =>
      runJob(job.data, {
        store,
        kv,
        events,
        analyzer: new MockAnalyzer({ watchDelayMs: 50 }),
        manifest,
        models,
      }),
    { connection: bull.duplicate() },
  );
});

afterAll(async () => {
  await worker.close();
  await queue.queue.close();
  for (const id of created) await store.delete(id);
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length) await redis.del(...keys);
  await sql.end({ timeout: 2 });
  for (const r of [redis, sub, bull]) r.disconnect();
});

describe("integration: real Postgres, Redis and BullMQ", () => {
  const goal = `integration ${prefix}`;

  it("runs a job end to end, then serves the repeat as a 200 cache hit", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/briefs",
      headers: AUTH,
      payload: { source: { url: MOCK_VIDEOS.short.id }, goal },
    });
    expect(res.statusCode).toBe(202);
    const id = res.json().id;
    created.push(id);

    await vi.waitFor(
      async () => {
        const b = (
          await app.inject({ method: "GET", url: `/v1/briefs/${id}`, headers: AUTH })
        ).json();
        expect(b.status).toBe("succeeded");
      },
      { timeout: 10000, interval: 100 },
    );

    const again = await app.inject({
      method: "POST",
      url: "/v1/briefs",
      headers: AUTH,
      payload: { source: { url: MOCK_VIDEOS.short.id }, goal },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: "succeeded", meta: { cached: true } });
    created.push(again.json().id);
  });

  it("encrypts the goal at rest and decrypts it on read", async () => {
    const [raw] = await sql`select goal from briefs where id = ${created[0]!}`;
    expect(raw!.goal).toMatch(/^v1:/);
    expect(raw!.goal).not.toContain("integration");
    expect((await store.get(created[0]!))?.goal).toBe(goal);
  });

  it("persists everything in Postgres, including the internal fields", async () => {
    const row = await store.get(created[0]!);
    expect(row).toMatchObject({ status: "succeeded", goal, detail: "standard" });
    expect(row?.spokenLines?.length).toBeGreaterThan(0);
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it("cancels a queued job through the real queue", async () => {
    await worker.pause();
    const res = await app.inject({
      method: "POST",
      url: "/v1/briefs",
      headers: AUTH,
      payload: { source: { url: MOCK_VIDEOS.tutorial.id }, goal: `${goal} cancel` },
    });
    const id = res.json().id;
    created.push(id);
    expect(
      (await app.inject({ method: "DELETE", url: `/v1/briefs/${id}`, headers: AUTH })).statusCode,
    ).toBe(204);
    worker.resume();
    await new Promise((r) => setTimeout(r, 500));
    expect((await store.get(id))?.status).toBe("cancelled");
  });
});
