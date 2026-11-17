/**
 * M5 acceptance: one test per row of the PRD's "Backend: error handling and failure modes"
 * table, using MockAnalyzer fault injection (faults go through the real Gemini error mapping).
 */
import {
  JobBudget,
  MOCK_UNAVAILABLE_ID,
  MOCK_VIDEOS,
  MockAnalyzer,
  withFallback,
  type MockAnalyzerOptions,
  type MockFault,
  type VideoLookup,
} from "@match-cut/providers";
import type { KV } from "@match-cut/infra";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AUTH, harness } from "./helpers.js";

const SHORT = MOCK_VIDEOS.short.id;
const fixture = JSON.parse(
  readFileSync(
    new URL("../packages/providers/fixtures/pass1/default.json", import.meta.url),
    "utf8",
  ),
);
const noSleep = async () => {};

/** Mock with faults, wrapped in the real retry/fallback chain (no backoff waits). */
function chained(faults: NonNullable<MockAnalyzerOptions["faults"]>) {
  const mock = new MockAnalyzer({ faults });
  const analyzer = withFallback(mock, { fallbacks: ["mock-fallback"], sleep: noSleep });
  return { mock, analyzer };
}

async function runOne(
  faults: Parameters<typeof chained>[0],
  opts: { body?: object; pipeline?: object; lookup?: VideoLookup } = {},
) {
  const { mock, analyzer } = chained(faults);
  const h = harness({ analyzer, pipeline: opts.pipeline, pipelineLookup: opts.lookup });
  const res = await h.post({ source: { url: SHORT }, ...opts.body });
  await h.idle();
  const id = res.json().id as string;
  return { h, mock, id, brief: await h.brief(id), record: (await h.deps.store.get(id))! };
}

const s503: MockFault = { status: 503 };

describe("PRD failure table", () => {
  it("Gemini 429: retried, then CAPACITY_EXHAUSTED if still failing", async () => {
    const r429: MockFault = { status: 429 };
    const ok = await runOne({ watch: [r429] });
    expect(ok.brief.status).toBe("succeeded");

    const { brief, record, mock } = await runOne({ watch: [r429, r429, r429] });
    expect(brief).toMatchObject({
      status: "failed",
      error: { code: "CAPACITY_EXHAUSTED", retryable: true },
    });
    expect(mock.calls.filter((c) => c.method === "watch").map((c) => c.model)).toEqual([
      "mock-flash",
      "mock-flash",
      "mock-fallback",
    ]);
    expect(record.meta.failure).toMatchObject({
      code: "CAPACITY_EXHAUSTED",
      upstreamStatus: 429,
      attempts: 3,
    });
  });

  it("Gemini 500/503: retry once, then the fallback model; UPSTREAM_ERROR if both fail", async () => {
    const saved = await runOne({ watch: [s503, s503] });
    expect(saved.brief).toMatchObject({ status: "succeeded", meta: { model: "mock-fallback" } });

    const failed = await runOne({ watch: [s503, { status: 500 }, s503] });
    expect(failed.brief).toMatchObject({ status: "failed", error: { code: "UPSTREAM_ERROR" } });
  });

  it("Gemini can't access the video: no retry; the precheck re-classifies it", async () => {
    const nowPrivate: VideoLookup = {
      lookup: async (id) => ({
        status: "found",
        video: { ...MOCK_VIDEOS.short, id, privacyStatus: "private" },
      }),
    };
    const { brief, mock } = await runOne(
      { watch: [{ status: 403, message: "permission denied" }] },
      { lookup: nowPrivate },
    );
    expect(brief).toMatchObject({ status: "failed", error: { code: "VIDEO_NOT_PUBLIC" } });
    expect(mock.calls.filter((c) => c.method === "watch")).toHaveLength(1);

    const gone: VideoLookup = { lookup: async () => ({ status: "not_found" }) };
    const deleted = await runOne({ watch: [{ status: 404 }] }, { lookup: gone });
    expect(deleted.brief.error?.code).toBe("VIDEO_NOT_FOUND");
  });

  it("request timeout: retried while 30 s remain; otherwise UPSTREAM_TIMEOUT", async () => {
    const retried = await runOne({ watch: ["timeout"] });
    expect(retried.brief.status).toBe("succeeded");

    // Job budget almost spent: no retry.
    const t0 = Date.now();
    const clock = vi.fn(() => t0);
    const { analyzer, mock } = chained({ watch: ["timeout"] });
    const budget = new JobBudget({ maxFailedAttempts: 4, timeoutMs: 20_000, now: clock });
    await expect(
      analyzer.watch(
        {
          videoId: SHORT,
          canonicalUrl: `https://www.youtube.com/watch?v=${SHORT}`,
          range: null,
          detail: "standard",
          model: "mock-flash",
          durationSeconds: 45,
        },
        undefined,
        { budget },
      ),
    ).rejects.toMatchObject({
      error: {
        code: "UPSTREAM_TIMEOUT",
        message: "This took too long. Shorter sections work faster.",
      },
    });
    expect(mock.calls).toHaveLength(1);
  });

  it("the job's wall-clock budget ends a hung call with UPSTREAM_TIMEOUT", async () => {
    const { brief } = await runOne(
      { watch: ["hang"] },
      { pipeline: { budget: { maxFailedAttempts: 4, timeoutMs: 50 } } },
    );
    expect(brief).toMatchObject({ status: "failed", error: { code: "UPSTREAM_TIMEOUT" } });
  });

  it("safety block: no retry, CONTENT_BLOCKED", async () => {
    for (const fault of [
      { finishReason: "SAFETY" },
      { blockReason: "PROHIBITED_CONTENT" },
    ] as MockFault[]) {
      const { brief, mock } = await runOne({ watch: [fault] });
      expect(brief).toMatchObject({
        status: "failed",
        error: { code: "CONTENT_BLOCKED", message: "This video can't be analyzed." },
      });
      expect(mock.calls).toHaveLength(1);
    }
  });

  it("recitation: retried once with a no-quoting reminder; INVALID_MODEL_OUTPUT if repeated", async () => {
    const once = await runOne({ watch: [{ finishReason: "RECITATION" }] });
    expect(once.brief.status).toBe("succeeded");
    expect(once.mock.calls.map((c) => c.hint)).toEqual([undefined, "no_quoting", undefined]);

    const twice = await runOne({
      watch: [{ finishReason: "RECITATION" }, { finishReason: "RECITATION" }],
    });
    expect(twice.brief).toMatchObject({
      status: "failed",
      error: { code: "INVALID_MODEL_OUTPUT" },
    });
    expect(twice.record.meta.failure).toMatchObject({ finishReason: "RECITATION" });
  });

  it("output cut off: retried once with be-concise; INVALID_MODEL_OUTPUT if repeated", async () => {
    const once = await runOne({ writePrompt: [{ finishReason: "MAX_TOKENS" }] });
    expect(once.brief.status).toBe("succeeded");
    expect(once.mock.calls.find((c) => c.hint)?.hint).toBe("be_concise");

    const twice = await runOne({
      watch: [{ finishReason: "MAX_TOKENS" }, { finishReason: "MAX_TOKENS" }],
    });
    expect(twice.brief.error?.code).toBe("INVALID_MODEL_OUTPUT");
  });

  it("empty response: retried; UPSTREAM_ERROR if it keeps happening", async () => {
    expect((await runOne({ watch: ["empty"] })).brief.status).toBe("succeeded");
    const failed = await runOne({ watch: ["empty", "empty", "empty"] });
    expect(failed.brief.error?.code).toBe("UPSTREAM_ERROR");
  });

  it("invalid JSON or schema mismatch: one repair call, INVALID_MODEL_OUTPUT if it fails", async () => {
    const fixed = await runOne({ watch: [{ output: undefined, text: "{oops" }] });
    expect(fixed.brief.status).toBe("succeeded");
    expect(fixed.mock.calls.filter((c) => c.method === "repair")).toHaveLength(1);

    const bad = { output: { summary: "x" } };
    const failed = await runOne({ watch: [bad], repair: [bad] });
    expect(failed.brief.error?.code).toBe("INVALID_MODEL_OUTPUT");
  });

  it("semantic failure: one repair call, INVALID_MODEL_OUTPUT if it fails", async () => {
    const overlapping = structuredClone(fixture);
    overlapping.beats[1].start = "00:01";
    const fixed = await runOne({ watch: [{ output: overlapping }] });
    expect(fixed.brief.status).toBe("succeeded");

    const tooShort = {
      output: {
        cardboard_prompt: "1. Cut.\n2. Trim.\n3. Done.",
        assets_needed: [],
        watch_outs: ["x"],
      },
    };
    const failed = await runOne({ writePrompt: [tooShort], repair: [tooShort] });
    // Pass 1 succeeded, so a pass 2 failure is partial (next row).
    expect(failed.brief.status).toBe("partial");
    expect(failed.record.meta.failure?.code).toBe("INVALID_MODEL_OUTPUT");
  });

  it("pass 1 succeeds, pass 2 fails: partial with the breakdown, then regenerate works", async () => {
    const { h, id, brief } = await runOne({ writePrompt: [s503, s503, s503] });
    expect(brief).toMatchObject({ status: "partial", cardboard_prompt: null, error: null });
    expect(brief.breakdown).not.toBeNull();
    await h.regenerate(id, {});
    await h.idle();
    expect((await h.brief(id)).status).toBe("succeeded");
  });

  it("YouTube Data API down: precheck skipped, the job still runs", async () => {
    const h = harness();
    const res = await h.post({ source: { url: MOCK_UNAVAILABLE_ID } });
    expect(res.statusCode).toBe(202);
    await h.idle();
    expect(await h.brief(res.json().id)).toMatchObject({
      status: "succeeded",
      video: { title: null, duration_seconds: null },
    });
  });

  it("cache store down: requests bypass the cache and still succeed", async () => {
    const broken: KV = {
      get: async () => Promise.reject(new Error("ECONNREFUSED")),
      set: async () => Promise.reject(new Error("ECONNREFUSED")),
      setIfAbsent: async () => Promise.reject(new Error("ECONNREFUSED")),
      del: async () => Promise.reject(new Error("ECONNREFUSED")),
      incrBy: async () => Promise.reject(new Error("ECONNREFUSED")),
    };
    const { SafeKV } = await import("@match-cut/infra");
    const warn = vi.fn();
    const h = harness({ app: { kv: new SafeKV(broken, warn) } });
    const res = await h.post({ source: { url: SHORT } }, { "idempotency-key": "k" });
    expect(res.statusCode).toBe(202);
    await h.idle();
    expect((await h.brief(res.json().id)).status).toBe("succeeded");
    expect(warn).toHaveBeenCalled();
  });

  it("job store down: short videos run synchronously; longer ones fail with INTERNAL", async () => {
    const syncRun = vi.fn(async (rec) => ({ ...rec, status: "succeeded" as const }));
    const failingQueue = { enqueue: async () => Promise.reject(new Error("queue unavailable")) };
    const h = harness({ app: { queue: failingQueue, syncRun } });
    const short = await h.post({ source: { url: SHORT } });
    expect(short.statusCode).toBe(200);
    expect(short.json().status).toBe("succeeded");
    expect(syncRun).toHaveBeenCalledOnce();
    expect(await h.deps.store.get(short.json().id)).toBeNull(); // nothing half-created left behind

    const long = await h.post({ source: { url: MOCK_VIDEOS.tutorial.id } }); // 8 minutes
    expect(long.statusCode).toBe(500);
    expect(long.json().error).toEqual({
      code: "INTERNAL",
      message: "Something went wrong while analyzing.",
      retryable: true,
    });
  });

  it("client disconnects mid-job: the job keeps running and the result is retrievable", async () => {
    const h = harness({ analyzer: new MockAnalyzer({ watchDelayMs: 30 }), autoRun: false });
    const base = await h.app.listen({ port: 0, host: "127.0.0.1" });
    const { id } = (await h.post({ source: { url: SHORT } })).json();
    const controller = new AbortController();
    const stream = fetch(`${base}/v1/briefs/${id}/events`, {
      headers: AUTH,
      signal: controller.signal,
    });
    await (await stream).body?.getReader().read();
    controller.abort(); // the client goes away
    await h.drain();
    expect((await h.brief(id)).status).toBe("succeeded");
    await h.app.close();
  });

  it("worker crashes mid-job: the requeued job resumes from the last finished pass", async () => {
    const mock = new MockAnalyzer();
    const h = harness({ analyzer: mock, autoRun: false });
    const { id } = (await h.post({ source: { url: SHORT } })).json();
    // Simulate a crash after pass 1: breakdown saved, status still processing.
    const { spoken_lines_internal, ...breakdown } = fixture;
    await h.deps.store.update(id, {
      status: "processing",
      stage: "writing_prompt",
      breakdown,
      spokenLines: spoken_lines_internal,
    });
    await h.drain();
    expect((await h.brief(id)).status).toBe("succeeded");
    expect(mock.calls.map((c) => c.method)).toEqual(["writePrompt"]);
  });
});

describe("Rules for every error", () => {
  it("never exposes raw Gemini text; keeps code, status, finish reason and attempts", async () => {
    const { h, id, record } = await runOne({
      watch: [{ status: 503, message: "secret upstream detail" }, s503, s503],
    });
    expect((await h.get(id)).body).not.toContain("secret upstream detail");
    expect(record.meta.failure).toEqual({
      code: "UPSTREAM_ERROR",
      upstreamStatus: 503,
      attempts: 3,
      models: ["mock-flash", "mock-fallback"],
    });
  });

  it("a Gemini billing problem stops at once and reads as capacity", async () => {
    const { brief, mock } = await runOne({
      watch: [{ status: 403, message: "Your billing account has an outstanding balance" }],
    });
    expect(brief.error?.code).toBe("CAPACITY_EXHAUSTED");
    expect(mock.calls).toHaveLength(1);
  });
});

describe("queue wait", () => {
  it("a job that waited over 2 minutes fails with CAPACITY_EXHAUSTED", async () => {
    let clock = Date.now();
    const h = harness({ autoRun: false, pipeline: { now: () => clock } });
    const { id } = (await h.post({ source: { url: SHORT } })).json();
    clock += 121_000;
    await h.drain();
    expect((await h.brief(id)).error?.code).toBe("CAPACITY_EXHAUSTED");
  });
});
