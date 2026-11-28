/**
 * M10.6: the playbook job end to end in mock mode (PRD-playbooks.md, Feature 3 > Request flow),
 * with fault injection for each failure path.
 */
import {
  FEATURE_COPY,
  loadManifest,
  loadPricing,
  modelNames,
  parseEnv,
  PLAYBOOK_STAGES,
  playbookInflightKey,
  type ChannelRef,
  type PlaybookStage,
} from "@match-cut/core";
import {
  MemoryBriefEvents,
  MemoryKV,
  MemoryPlaybookStore,
  type PlaybookRecord,
} from "@match-cut/infra";
import {
  GOLDEN_CHANNEL_HANDLES,
  MOCK_CHANNEL_SPECS,
  MockAnalyzer,
  MockChannelLookup,
  type ChannelLookup,
  type MockAnalyzerOptions,
} from "@match-cut/providers";
import {
  failDeadPlaybook,
  failStalePlaybooks,
  runPlaybookJob,
  type PlaybookPipelineDeps,
} from "@match-cut/worker/playbook-pipeline";
import { describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-11-24T12:00:00Z").getTime();
const models = modelNames(parseEnv({ DEV_API_TOKEN: "x", PROVIDER: "mock" }));
const manifest = loadManifest();
let n = 0;

function setup(
  opts: {
    faults?: MockAnalyzerOptions["faults"];
    kv?: MemoryKV;
    channels?: ChannelLookup;
    deps?: Partial<PlaybookPipelineDeps>;
  } = {},
) {
  const store = new MemoryPlaybookStore();
  const kv = opts.kv ?? new MemoryKV(() => NOW);
  const events = new MemoryBriefEvents();
  const analyzer = new MockAnalyzer({ faults: opts.faults });
  const logs: { msg: string; extra?: Record<string, unknown> }[] = [];
  const spend = { add: vi.fn(async () => {}), overCap: vi.fn(async () => false) };
  const deps: PlaybookPipelineDeps = {
    store,
    kv,
    events,
    channels: opts.channels ?? new MockChannelLookup({ now: () => new Date(NOW) }),
    analyzer,
    manifest,
    models,
    pricing: loadPricing(),
    spend: spend as never,
    now: () => NOW,
    log: (msg, extra) => logs.push({ msg, extra }),
    ...opts.deps,
  };
  return { store, kv, events, analyzer, deps, logs, spend };
}

function newPlaybook(source: ChannelRef, over: Partial<PlaybookRecord> = {}): PlaybookRecord {
  const t = new Date(NOW);
  return {
    id: `pb_${++n}`,
    userId: "user_1",
    orgId: "org_1",
    status: "queued",
    stage: null,
    progress: null,
    source,
    settings: { windowDays: 90, maxVideos: 50, outlierThreshold: 2 },
    forceRefresh: false,
    channel: null,
    window: null,
    baseline: null,
    notEnoughData: null,
    videos: [],
    comparison: null,
    content: null,
    spokenLines: null,
    warnings: [],
    error: null,
    meta: { models: {}, versions: {}, cached: false, timingsMs: {}, tokens: {} },
    createdAt: t,
    updatedAt: t,
    ...over,
  };
}

async function run(
  s: ReturnType<typeof setup>,
  handle: string,
  over: Partial<PlaybookRecord> = {},
): Promise<PlaybookRecord> {
  const rec = newPlaybook({ kind: "handle", handle }, over);
  await s.store.create(rec);
  await runPlaybookJob({ playbookId: rec.id }, s.deps);
  return (await s.store.get(rec.id))!;
}

const calls = (s: ReturnType<typeof setup>, method: string) =>
  s.analyzer.calls.filter((c) => c.method === method).length;

describe("playbook job: every golden channel (M10 done-when)", () => {
  it.each(GOLDEN_CHANNEL_HANDLES)("%s succeeds with its planted pattern", async (handle) => {
    const s = setup();
    const pb = await run(s, handle);
    expect(pb.error).toBeNull();
    expect(pb.status).toBe("succeeded");
    const spec = MOCK_CHANNEL_SPECS.find((x) => x.handle === handle)!;
    // The first planted feature always reaches a rule; the content mirrors the comparison.
    const [feature, value] = Object.entries(spec.pattern!)[0]!;
    expect(pb.content!.rules.map((r) => `${r.feature}=${r.value}`)).toContain(
      `${feature}=${value}`,
    );
    expect(pb.content!.rules.map((r) => [r.feature, r.value])).toEqual(
      pb.comparison!.rules.map((r) => [r.feature, r.value]),
    );
    expect(pb.content!.recipe_prompt_template).toContain("{{GOAL}}");
    expect(pb.channel).toMatchObject({ handle, id: expect.stringMatching(/^UC/) });
    expect(pb.window!.shortsEligible).toBeGreaterThanOrEqual(10);
    expect(pb.videos.length).toBe(pb.window!.uploadsSeen);
    expect(pb.spokenLines!.length).toBeGreaterThan(0);
    expect(pb.stage).toBeNull();
    expect(pb.meta).toMatchObject({
      cached: false,
      models: { pass1: models.standard, features: models.pass2, playbook: models.pass2 },
      versions: { features: "f1", comparison: "c1", playbook: "pb1" },
    });
    expect(pb.meta.tokens.pass1_input).toBeGreaterThan(0);
    expect(pb.meta.costUsd).toBeGreaterThan(0);
    expect(s.spend.add).toHaveBeenCalled();
    // findRecent sees it (the API's 24-hour repeat check).
    expect(
      await s.store.findRecent({
        userId: "user_1",
        channelId: pb.channel!.id,
        settings: pb.settings,
        since: new Date(NOW - 1000),
      }),
    ).not.toBeNull();
  });
});

describe("playbook job: flow", () => {
  it("goes through the PRD's stages in order, with watching progress", async () => {
    const s = setup();
    const rec = newPlaybook({ kind: "handle", handle: "mockgolden06" });
    await s.store.create(rec);
    const seen: (PlaybookStage | null)[] = [];
    const progress: string[] = [];
    await s.events.subscribe(rec.id, () => {
      const r = s.store.rows.get(rec.id)!;
      if (r.stage && seen.at(-1) !== r.stage) seen.push(r.stage);
      if (r.progress) progress.push(`${r.progress.done}/${r.progress.total}`);
    });
    await runPlaybookJob({ playbookId: rec.id }, s.deps);
    expect(seen).toEqual([...PLAYBOOK_STAGES]);
    expect(progress[0]).toBe("0/10");
    expect(progress.at(-1)).toBe("10/10");
    expect(s.store.rows.get(rec.id)!.progress).toBeNull();
  });

  it("watches at most 3 videos at a time", async () => {
    const s = setup();
    let inFlight = 0;
    let most = 0;
    const watch = s.analyzer.watch.bind(s.analyzer);
    s.analyzer.watch = async (...args) => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await watch(...args);
      } finally {
        inFlight--;
      }
    };
    await run(s, "mockgolden06");
    expect(calls(s, "watch")).toBe(10);
    expect(most).toBe(3);
  });

  it("shares pass 1 with briefs, caches features, and caches the playbook for 24 hours", async () => {
    const kv = new MemoryKV(() => NOW);
    const first = setup({ kv });
    const a = await run(first, "mockgolden04");
    expect(calls(first, "watch")).toBe(9);

    // Another user, same channel and settings: the cached playbook, no model calls.
    const second = setup({ kv });
    const b = await run(second, "mockgolden04", { userId: "user_2" });
    expect(second.analyzer.calls).toEqual([]);
    expect(b).toMatchObject({ status: "succeeded", meta: { cached: true } });
    expect(b.content).toEqual(a.content);

    // Different settings: no playbook cache, but pass 1 and features come from cache.
    const third = setup({ kv });
    const c = await run(third, "mockgolden04", {
      settings: { windowDays: 91, maxVideos: 50, outlierThreshold: 2 },
    });
    expect(c.status).toBe("succeeded");
    expect(calls(third, "watch")).toBe(0);
    expect(calls(third, "extractFeatures")).toBe(0);
    expect(calls(third, "writePlaybook")).toBe(1);

    // force_refresh skips feature and playbook caches; the pass 1 cache still applies.
    const fourth = setup({ kv });
    await run(fourth, "mockgolden04", { forceRefresh: true });
    expect(calls(fourth, "watch")).toBe(0);
    expect(calls(fourth, "extractFeatures")).toBe(9);
    expect(calls(fourth, "writePlaybook")).toBe(1);
  });

  it("resumes after a crash from the caches", async () => {
    const kv = new MemoryKV(() => NOW);
    await run(setup({ kv }), "mockgolden03", { forceRefresh: true });
    const s = setup({ kv });
    const pb = await run(s, "mockgolden03", { status: "processing", stage: "watching" });
    expect(pb.status).toBe("succeeded");
    expect(calls(s, "watch")).toBe(0);
    expect(s.logs.find((l) => l.msg === "playbook finished")!.extra).toMatchObject({
      resumed: true,
    });
  });

  it("does nothing for a finished or missing playbook", async () => {
    const s = setup();
    const pb = await run(s, "mockgolden01", { status: "succeeded" });
    expect(pb.status).toBe("succeeded");
    expect(s.analyzer.calls).toEqual([]);
    await runPlaybookJob({ playbookId: "pb_missing" }, s.deps);
  });

  it("with no rule, code writes the playbook: no writing call, NO_CLEAR_PATTERN", async () => {
    for (const handle of ["mockmixed", "mockhidden", "mocknew"]) {
      const s = setup();
      const pb = await run(s, handle);
      expect(pb.status, handle).toBe("succeeded");
      const none = pb.content!.rules.length === 0;
      expect(calls(s, "writePlaybook") === 0, handle).toBe(none);
      expect(
        pb.warnings.some((w) => w.code === "NO_CLEAR_PATTERN"),
        handle,
      ).toBe(none);
    }
  });

  it("logs one line per job, without titles or the channel input", async () => {
    const s = setup();
    const pb = await run(s, "mockgolden01");
    const line = s.logs.find((l) => l.msg === "playbook finished")!.extra!;
    expect(line).toMatchObject({ outcome: "succeeded", picked: 8, skipped: 0, cached: false });
    const json = JSON.stringify(line);
    expect(json).not.toContain(pb.videos[0]!.title);
    expect(json).not.toContain("mockgolden01");
  });
});

describe("playbook job: failures (PRD error codes)", () => {
  it("CHANNEL_NOT_FOUND, with no model calls", async () => {
    const s = setup();
    const pb = await run(s, "mockgone");
    expect(pb).toMatchObject({ status: "failed", error: { code: "CHANNEL_NOT_FOUND" } });
    expect(s.analyzer.calls).toEqual([]);
  });

  it("YouTube quota -> CAPACITY_EXHAUSTED; other outages -> UPSTREAM_ERROR", async () => {
    const quota: ChannelLookup = {
      resolve: async () => ({ status: "unavailable", reason: "quota" }),
      recentUploads: async () => ({ status: "unavailable", reason: "quota" }),
    };
    expect((await run(setup({ channels: quota }), "x")).error!.code).toBe("CAPACITY_EXHAUSTED");
    expect((await run(setup(), "mockdown")).error).toMatchObject({
      code: "UPSTREAM_ERROR",
      retryable: true,
    });
  });

  it("NOT_ENOUGH_DATA keeps the reasons and counts, with no model calls", async () => {
    const s = setup();
    const tiny = await run(s, "mocktiny");
    expect(tiny).toMatchObject({
      status: "failed",
      error: { code: "NOT_ENOUGH_DATA" },
      notEnoughData: {
        reasons: expect.arrayContaining(["TOO_FEW_SHORTS"]),
        minimums: { eligible: 10, outliers: 3, typical: 3 },
      },
    });
    expect(tiny.window).not.toBeNull();
    const flat = await run(s, "mockflat");
    expect(flat.notEnoughData).toMatchObject({ reasons: ["TOO_FEW_BREAKOUTS"], outliersFound: 0 });
    expect(s.analyzer.calls).toEqual([]);
  });

  it("a video that can't be analyzed is left out, with a warning, and nothing is cached", async () => {
    const s = setup({ faults: { watch: [{ status: 400, message: "can't access" }] } });
    const pb = await run(s, "mockgolden06");
    expect(pb.status).toBe("succeeded");
    expect(pb.comparison!.features).toHaveLength(9);
    expect(pb.warnings.map((w) => w.code)).toContain("VIDEOS_SKIPPED");
    expect(pb.warnings.find((w) => w.code === "VIDEOS_SKIPPED")!.message).toMatch(/^1 of the/);
    expect(s.logs.some((l) => l.msg === "playbook video skipped")).toBe(true);
    // Not cached as the channel's playbook: a later request should try every video again.
    const again = setup({ kv: s.kv });
    await run(again, "mockgolden06", { userId: "user_2" });
    expect(calls(again, "writePlaybook")).toBe(1);
  });

  it("too many videos failing fails the playbook with the upstream error", async () => {
    const s = setup({ faults: { watch: Array.from({ length: 8 }, () => ({ status: 503 })) } });
    const pb = await run(s, "mockgolden01");
    expect(pb).toMatchObject({
      status: "failed",
      error: { code: "UPSTREAM_ERROR", retryable: true },
    });
  });

  it("feature output that stays invalid after the repair leaves that video out", async () => {
    const s = setup({ faults: { extractFeatures: [{ output: { hook_type: "nonsense" } }] } });
    const pb = await run(s, "mockgolden06");
    expect(pb.status).toBe("succeeded");
    expect(calls(s, "repair")).toBe(1);
    expect(pb.comparison!.features).toHaveLength(9);
    expect(pb.meta.repairUsed).toBe(true);
  });

  it("a writer outage still gives a playbook: computed rules, fallback wording, no recipe", async () => {
    const s = setup({ faults: { writePlaybook: [{ status: 503 }] } });
    const pb = await run(s, "mockgolden01");
    expect(pb.status).toBe("succeeded");
    expect(pb.meta.fallbacksUsed).toBe(true);
    expect(pb.content!.recipe_prompt_template).toBeNull();
    expect(pb.warnings.map((w) => w.code)).toContain("RECIPE_UNAVAILABLE");
    for (const r of pb.content!.rules) {
      expect(r.title).toBe(FEATURE_COPY[r.feature]![r.value]!.title);
    }
  });

  it("writer output with problems gets one repair", async () => {
    const s = setup({ faults: { writePlaybook: [{ output: { rules: [] } }] } });
    const pb = await run(s, "mockgolden01");
    expect(pb.status).toBe("succeeded");
    expect(calls(s, "repair")).toBe(1);
    expect(pb.meta).toMatchObject({ repairUsed: true, fallbacksUsed: true });
  });

  it("a cancel stops the job and wins over any later write", async () => {
    const s = setup({ faults: { watch: Array.from({ length: 10 }, () => "hang" as const) } });
    const rec = newPlaybook({ kind: "handle", handle: "mockgolden01" });
    await s.store.create(rec);
    const job = runPlaybookJob({ playbookId: rec.id }, s.deps);
    await vi.waitFor(() => expect(s.store.rows.get(rec.id)!.stage).toBe("watching"));
    await s.store.update(rec.id, { status: "cancelled", stage: null });
    await s.events.publish(rec.id);
    await job;
    expect(s.store.rows.get(rec.id)!.status).toBe("cancelled");
    expect(s.logs.find((l) => l.msg === "playbook finished")!.extra!.outcome).toBe("cancelled");
  });

  it("the whole-playbook time limit fails with UPSTREAM_TIMEOUT", async () => {
    const s = setup({
      faults: { watch: Array.from({ length: 10 }, () => "hang" as const) },
      deps: { timeoutMs: 30 },
    });
    const pb = await run(s, "mockgolden01");
    expect(pb).toMatchObject({ status: "failed", error: { code: "UPSTREAM_TIMEOUT" } });
  });

  it("a job that waited too long in the queue fails with CAPACITY_EXHAUSTED", async () => {
    const s = setup({ deps: { queueMaxWaitMs: 120_000 } });
    const pb = await run(s, "mockgolden01", { createdAt: new Date(NOW - 200_000) });
    expect(pb.error!.code).toBe("CAPACITY_EXHAUSTED");
    expect(s.analyzer.calls).toEqual([]);
  });
});

describe("playbook job: review fixes (M10.6)", () => {
  it("a passing failure fails fast as retryable, stops the other calls, and refunds", async () => {
    const refund = vi.fn(async () => {});
    const s = setup({ faults: { watch: [{ status: 503 }] }, deps: { refund } });
    const pb = await run(s, "mockgolden06");
    expect(pb).toMatchObject({
      status: "failed",
      error: { code: "UPSTREAM_ERROR", retryable: true },
    });
    expect(calls(s, "watch")).toBeLessThan(10);
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it("no refund when the failure is about the user's input", async () => {
    const refund = vi.fn(async () => {});
    const s = setup({ deps: { refund } });
    await run(s, "mockgone");
    await run(s, "mocktiny");
    expect(refund).not.toHaveBeenCalled();
  });

  it("a failed progress write doesn't fail the playbook", async () => {
    const s = setup();
    const update = s.store.update.bind(s.store);
    let failedOnce = false;
    s.store.update = async (id, patch, opts) => {
      if (!failedOnce && patch.progress && patch.progress.done === 3 && !patch.stage) {
        failedOnce = true;
        throw new Error("database blip");
      }
      return update(id, patch, opts);
    };
    const pb = await run(s, "mockgolden06");
    expect(failedOnce).toBe(true);
    expect(pb.status).toBe("succeeded");
  });

  it("marks which videos were compared; a skipped pick isn't", async () => {
    const s = setup({ faults: { watch: [{ status: 400 }] } });
    const pb = await run(s, "mockgolden06");
    const picks = pb.videos.filter((v) => v.group === "outlier" || v.group === "typical");
    expect(picks.filter((v) => v.compared)).toHaveLength(9);
    expect(picks.filter((v) => !v.compared)).toHaveLength(1);
    expect(pb.meta.skipped).toBe(1);
    expect(pb.videos.filter((v) => v.group === "other").every((v) => !v.compared)).toBe(true);
  });

  it("damaged cache entries are misses, not failures", async () => {
    const kv = new MemoryKV(() => NOW);
    await run(setup({ kv }), "mockgolden04");
    for (const [key, entry] of kv.data) {
      if (key.startsWith("p1:")) entry.value = "{not json";
      if (key.startsWith("feat:"))
        entry.value = JSON.stringify({ values: { hook_type: "clickbait" } });
      if (key.startsWith("pb:")) entry.value = JSON.stringify({ channel: { id: "x" } });
    }
    const s = setup({ kv });
    const pb = await run(s, "mockgolden04", { userId: "user_2" });
    expect(pb.status).toBe("succeeded");
    expect(pb.meta.cached).toBe(false);
    expect(calls(s, "watch")).toBe(9);
    expect(calls(s, "extractFeatures")).toBe(9);
  });

  it("results from a fallback model aren't cached at any layer", async () => {
    const s = setup();
    const extract = s.analyzer.extractFeatures.bind(s.analyzer);
    s.analyzer.extractFeatures = async (...args) => ({
      ...(await extract(...args)),
      fallbackUsed: true,
    });
    const pb = await run(s, "mockgolden04");
    expect(pb.meta.fallbackModelUsed).toBe(true);
    const keys = [...s.kv.data.keys()];
    expect(keys.some((k) => k.startsWith("feat:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("pb:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("p1:"))).toBe(true);
  });

  it("a resumed job keeps what the crashed run already spent", async () => {
    const s = setup();
    const pb = await run(s, "mockgolden01", {
      status: "processing",
      meta: {
        models: {},
        versions: {},
        cached: false,
        timingsMs: { watching: 5000 },
        tokens: { pass1_input: 7 },
        costUsd: 1.5,
      },
    });
    expect(pb.status).toBe("succeeded");
    expect(pb.meta.costUsd).toBeGreaterThan(1.5);
    expect(pb.meta.tokens.pass1_input).toBeGreaterThan(7);
    expect(pb.meta.timingsMs.watching).toBeGreaterThanOrEqual(5000);
  });

  it("counts the tokens of a video whose output stayed invalid", async () => {
    const s = setup();
    const watch = s.analyzer.watch.bind(s.analyzer);
    const repair = s.analyzer.repair.bind(s.analyzer);
    let bad = 1;
    s.analyzer.watch = async (input, signal, ctx) =>
      bad-- > 0
        ? { output: {}, model: input.model, usage: { inputTokens: 1234, outputTokens: 5 } }
        : watch(input, signal, ctx);
    s.analyzer.repair = async (input, signal, ctx) =>
      input.pass === 1
        ? { output: {}, model: input.model, usage: { inputTokens: 100, outputTokens: 5 } }
        : repair(input, signal, ctx);
    const pb = await run(s, "mockgolden06");
    expect(pb.status).toBe("succeeded");
    expect(pb.meta.skipped).toBe(1);
    expect(pb.meta.repairUsed).toBe(true);
    // 9 good watches at 18,000 input tokens each, plus the failed watch and its repair.
    expect(pb.meta.tokens.pass1_input).toBe(9 * 18_000 + 1234 + 100);
  });
});

describe("playbook job: M10 review fixes (cost and stuck jobs)", () => {
  it("too few analyzable videos fails without a refund: paid watches can't be retried for free", async () => {
    const refund = vi.fn(async () => {});
    const blocked = Array.from({ length: 10 }, () => ({ finishReason: "SAFETY" }));
    const s = setup({ faults: { watch: blocked }, deps: { refund } });
    const pb = await run(s, "mockgolden01");
    expect(pb.error!.code).toBe("INVALID_MODEL_OUTPUT");
    expect(refund).not.toHaveBeenCalled();
  });

  it("Gemini refusing every video with a 4xx is a configuration fault: refunded, with an alert", async () => {
    const refund = vi.fn(async () => {});
    const refused = Array.from({ length: 10 }, () => ({ status: 400 }));
    const s = setup({ faults: { watch: refused }, deps: { refund } });
    const pb = await run(s, "mockgolden01");
    expect(pb.error!.code).toBe("UPSTREAM_ERROR");
    expect(refund).toHaveBeenCalledTimes(1);
    expect(s.logs.some((l) => l.msg.startsWith("ALERT: Gemini refused every video"))).toBe(true);
  });

  it("a 4xx while extracting features fails the playbook instead of skipping the video", async () => {
    const s = setup({ faults: { extractFeatures: [{ status: 400 }] } });
    const pb = await run(s, "mockgolden06");
    expect(pb).toMatchObject({ status: "failed", error: { code: "UPSTREAM_ERROR" } });
  });

  it("the daily spend cap stops a running playbook before its next paid call", async () => {
    const refund = vi.fn(async () => {});
    const s = setup({ deps: { refund } });
    s.spend.overCap.mockResolvedValueOnce(false).mockResolvedValue(true);
    const pb = await run(s, "mockgolden01");
    expect(pb.error!.code).toBe("CAPACITY_EXHAUSTED");
    expect(calls(s, "watch")).toBeLessThan(4);
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it("releases the in-flight key when the job ends, only if it names this playbook", async () => {
    const s = setup();
    const found = await new MockChannelLookup({ now: () => new Date(NOW) }).resolve({
      kind: "handle",
      handle: "mockgolden01",
    });
    const channelId = found.status === "found" ? found.channel.id : "";
    const key = playbookInflightKey("user_1", channelId, {
      windowDays: 90,
      maxVideos: 50,
      outlierThreshold: 2,
    });
    await s.kv.set(key, `pb_${n + 1}`, 600);
    await run(s, "mockgolden01");
    expect(await s.kv.get(key)).toBeNull();
    await s.kv.set(key, "pb_someone_newer", 600);
    await run(s, "mockgolden01", { forceRefresh: true });
    expect(await s.kv.get(key)).toBe("pb_someone_newer");
  });

  it("a job that died is failed as INTERNAL, refunded and alerted; finished ones are left alone", async () => {
    const s = setup();
    const refund = vi.fn(async () => {});
    const old = new Date(NOW - 60 * 60_000);
    const stuck = newPlaybook(
      { kind: "handle", handle: "mockgolden01" },
      { status: "processing", stage: "watching", updatedAt: old },
    );
    const done = newPlaybook(
      { kind: "handle", handle: "mockgolden01" },
      { status: "succeeded", updatedAt: old },
    );
    const recent = newPlaybook({ kind: "handle", handle: "mockgolden01" }, { status: "queued" });
    for (const r of [stuck, done, recent]) await s.store.create(r);
    const d = { store: s.store, kv: s.kv, events: s.events, refund, log: s.deps.log };
    expect(await failStalePlaybooks({ ...d, staleAfterMs: 20 * 60_000, now: () => NOW })).toBe(1);
    expect(await s.store.get(stuck.id)).toMatchObject({
      status: "failed",
      stage: null,
      error: { code: "INTERNAL" },
    });
    expect((await s.store.get(done.id))!.status).toBe("succeeded");
    expect((await s.store.get(recent.id))!.status).toBe("queued");
    expect(refund).toHaveBeenCalledTimes(1);
    expect(s.logs.some((l) => l.msg.startsWith("ALERT: a playbook job died"))).toBe(true);
    // The worker's "failed" handler: already finished means nothing to do.
    expect(await failDeadPlaybook(d, stuck.id, "job_failed")).toBe(false);
    expect(await failDeadPlaybook(d, recent.id, "job_failed")).toBe(true);
  });
});
