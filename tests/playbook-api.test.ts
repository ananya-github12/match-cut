/**
 * M10.7: playbook and skill endpoints end to end in mock mode (PRD-playbooks.md, API additions
 * and Feature 4): API + playbook worker + brief worker, all in memory.
 */
import { buildApp, type AppDeps } from "@match-cut/api/app";
import { memoryDeps } from "@match-cut/api/testing";
import {
  loadPricing,
  SKILLS_PER_USER,
  type PlaybookResponse,
  type SkillResponse,
} from "@match-cut/core";
import {
  defaultRules,
  MemoryJobQueue,
  MemoryKV,
  MemoryPlaybookQueue,
  MemoryPlaybookStore,
  MemorySkillStore,
  RateLimiter,
  SpendTracker,
  type PlaybookJobData,
} from "@match-cut/infra";
import { MOCK_FAULT_IDS, MOCK_VIDEOS, MockAnalyzer, MockChannelLookup } from "@match-cut/providers";
import { runJob } from "@match-cut/worker/pipeline";
import { runPlaybookJob } from "@match-cut/worker/playbook-pipeline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH } from "./helpers.js";
import { skillRecord } from "./playbook-fixtures.js";

type Headers = Record<string, string>;
const OTHER: Headers = { ...AUTH, "x-dev-user-id": "someone-else" };

function setup(
  opts: {
    autoRun?: boolean;
    app?: Partial<AppDeps>;
    playbooksPerDay?: number;
    pricing?: ReturnType<typeof loadPricing>;
  } = {},
) {
  const kv = new MemoryKV();
  const limiter = new RateLimiter(
    kv,
    defaultRules({
      userPerHour: 100,
      userPerDay: 100,
      regeneratePerHour: 100,
      orgPerDay: 1000,
      playbooksPerDay: opts.playbooksPerDay ?? 50,
    }),
  );
  const pbQueue = new MemoryPlaybookQueue();
  const briefQueue = new MemoryJobQueue();
  const analyzer = new MockAnalyzer();
  const channels = new MockChannelLookup();
  const base = memoryDeps({ kv, limiter, queue: briefQueue });
  const playbooks = {
    store: new MemoryPlaybookStore(),
    skills: new MemorySkillStore(),
    queue: pbQueue,
    channels,
    analyzer,
    pricing: opts.pricing,
  };
  const deps: AppDeps = { ...base, playbooks, ...opts.app };
  const pbDeps = {
    store: playbooks.store,
    kv,
    events: deps.events,
    channels,
    analyzer,
    manifest: deps.manifest,
    models: deps.models,
    refund: (pb: { userId: string; orgId: string; createdAt: Date }) =>
      limiter.refund("playbook", pb, pb.createdAt),
  };
  const running = new Set<Promise<void>>();
  const runPb = (job: PlaybookJobData) => {
    const p = runPlaybookJob(job, pbDeps).finally(() => running.delete(p));
    running.add(p);
    return p;
  };
  if (opts.autoRun ?? true) pbQueue.onEnqueue = (job) => void runPb(job);
  briefQueue.onEnqueue = (job) => {
    const p = runJob(job, {
      store: deps.store,
      kv,
      events: deps.events,
      analyzer,
      manifest: deps.manifest,
      models: deps.models,
    }).finally(() => running.delete(p));
    running.add(p);
  };
  const app = buildApp(deps);
  const inject = (
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: unknown,
    headers: Headers = AUTH,
  ) => app.inject({ method, url, payload: payload as object, headers });
  return {
    app,
    deps,
    kv,
    limiter,
    analyzer,
    pbQueue,
    store: playbooks.store,
    skills: playbooks.skills,
    inject,
    async idle() {
      while (running.size) await Promise.all([...running]);
    },
    async drain() {
      await Promise.all(pbQueue.jobs.splice(0).map(runPb));
    },
    create: (body: unknown, headers: Headers = AUTH) =>
      inject("POST", "/v1/playbooks", body, headers),
    async finished(body: unknown = { source: { channel: "@mockgolden01" } }) {
      const res = await inject("POST", "/v1/playbooks", body);
      await this.idle();
      return (await inject("GET", `/v1/playbooks/${res.json().id}`)).json() as PlaybookResponse;
    },
  };
}

let current: ReturnType<typeof setup> | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

describe("POST /v1/playbooks", () => {
  it("returns 202 with a job, which finishes with the PRD's playbook object", async () => {
    const h = (current = setup({ autoRun: false }));
    const res = await h.create({ source: { channel: "@mockgolden01" } });
    expect(res.statusCode).toBe(202);
    const job = res.json() as PlaybookResponse;
    expect(res.headers.location).toBe(`/v1/playbooks/${job.id}`);
    expect(job).toMatchObject({ status: "queued", rules: null });
    // The channel is resolved before queueing.
    expect(job.channel).toMatchObject({ handle: "mockgolden01" });
    await h.drain();
    const done = (await h.inject("GET", `/v1/playbooks/${job.id}`)).json() as PlaybookResponse;
    expect(done.status).toBe("succeeded");
    expect(done.rules!.length).toBeGreaterThan(0);
    expect(done.recipe_prompt_template).toContain("{{GOAL}}");
    expect(done.videos.some((v) => v.compared)).toBe(true);
    expect(done.not_enough_data).toBeNull();
    // Internals stay in the backend: speech, the parsed source, the comparison.
    expect(JSON.stringify(done)).not.toMatch(/spokenLines|spoken_lines|"source"|"comparison":\{/);
  });

  it("maps bad input to the PRD's codes", async () => {
    const h = (current = setup());
    const cases: [unknown, number, string][] = [
      [{}, 400, "INVALID_URL"],
      [{ source: { channel: "not a channel" } }, 400, "INVALID_URL"],
      [{ source: { channel: "https://www.youtube.com/c/legacy" } }, 400, "UNSUPPORTED_SOURCE"],
      [{ source: { channel: "@mockgolden01" }, window_days: 10 }, 400, "INVALID_REQUEST"],
      [{ source: { channel: "@mockgolden01" }, outlier_threshold: 20 }, 400, "INVALID_REQUEST"],
      [{ source: { mine: true } }, 403, "YOUTUBE_NOT_CONNECTED"],
      [{ source: { channel: "@mockgone" } }, 404, "CHANNEL_NOT_FOUND"],
    ];
    for (const [body, status, code] of cases) {
      const res = await h.create(body);
      expect([res.statusCode, res.json().error.code], JSON.stringify(body)).toEqual([status, code]);
    }
    expect((await h.inject("POST", "/v1/playbooks", {}, {})).statusCode).toBe(401);
  });

  it("returns the same finished playbook (200) for a repeat within 24 hours", async () => {
    const h = (current = setup());
    const first = await h.finished();
    const repeat = await h.create({ source: { channel: "https://www.youtube.com/@mockgolden01" } });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().id).toBe(first.id);
    // Different settings or force_refresh: a new job.
    const other = await h.create({ source: { channel: "@mockgolden01" }, window_days: 60 });
    expect(other.statusCode).toBe(202);
    const forced = await h.create({ source: { channel: "@mockgolden01" }, force_refresh: true });
    expect(forced.statusCode).toBe(202);
    expect(forced.json().id).not.toBe(first.id);
  });

  it("doesn't serve a degraded playbook as the repeat", async () => {
    const h = (current = setup());
    const first = await h.finished();
    await h.store.update(first.id, {
      meta: { ...(await h.store.get(first.id))!.meta, skipped: 1 },
    });
    const res = await h.create({ source: { channel: "@mockgolden01" } });
    expect(res.statusCode).toBe(202);
    expect(res.json().id).not.toBe(first.id);
  });

  it("attaches a repeat to the running job, and honors idempotency keys", async () => {
    const h = (current = setup({ autoRun: false }));
    const a = await h.create({ source: { channel: "@mockgolden02" } });
    const b = await h.create({ source: { channel: "@mockgolden02" } });
    expect(b.statusCode).toBe(202);
    expect(b.json().id).toBe(a.json().id);
    const k1 = await h.create(
      { source: { channel: "@mockgolden03" } },
      { ...AUTH, "idempotency-key": "k-1" },
    );
    const k2 = await h.create(
      { source: { channel: "@mockgolden04" } },
      { ...AUTH, "idempotency-key": "k-1" },
    );
    expect(k2.json().id).toBe(k1.json().id);
    expect(h.pbQueue.jobs).toHaveLength(2);
  });

  it("limits playbooks per user per day; repeats and attaches don't count", async () => {
    const h = (current = setup({ playbooksPerDay: 2 }));
    await h.finished({ source: { channel: "@mockgolden01" } });
    expect((await h.create({ source: { channel: "@mockgolden01" } })).statusCode).toBe(200);
    await h.finished({ source: { channel: "@mockgolden02" } });
    const third = await h.create({ source: { channel: "@mockgolden03" } });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("RATE_LIMITED");
    expect(third.headers["retry-after"]).toBeDefined();
  });

  it("a playbook that fails for an upstream reason gives the slot back", async () => {
    const h = (current = setup({ playbooksPerDay: 1 }));
    h.analyzer.watch = async () => {
      throw new (await import("@match-cut/core")).MatchCutError("UPSTREAM_ERROR");
    };
    const failed = await h.finished({ source: { channel: "@mockgolden01" } });
    expect(failed.error!.code).toBe("UPSTREAM_ERROR");
    expect((await h.create({ source: { channel: "@mockgolden02" } })).statusCode).toBe(202);
  });

  it("refuses new playbooks over the spend cap, and when the queue is down", async () => {
    const spend = new SpendTracker(new MemoryKV(), { capUsd: 0 });
    const h = (current = setup({ app: { spend } }));
    const over = await h.create({ source: { channel: "@mockgolden01" } });
    expect([over.statusCode, over.json().error.code]).toEqual([503, "CAPACITY_EXHAUSTED"]);

    const h2 = setup();
    h2.pbQueue.enqueue = async () => {
      throw new Error("redis down");
    };
    const down = await h2.create({ source: { channel: "@mockgolden01" } });
    expect([down.statusCode, down.json().error.code]).toEqual([500, "INTERNAL"]);
    expect(h2.store.rows.size).toBe(0);
    await h2.app.close();
  });

  it("NOT_ENOUGH_DATA comes back with the reasons and counts", async () => {
    const h = (current = setup());
    const pb = await h.finished({ source: { channel: "@mocktiny" } });
    expect(pb).toMatchObject({
      status: "failed",
      error: { code: "NOT_ENOUGH_DATA" },
      not_enough_data: {
        reasons: expect.arrayContaining(["TOO_FEW_SHORTS"]),
        minimums: { shorts_eligible: 10, outliers: 3, typical: 3 },
      },
    });
  });
});

describe("GET, DELETE and events", () => {
  it("only the owner can see a playbook", async () => {
    const h = (current = setup());
    const pb = await h.finished();
    const res = await h.inject("GET", `/v1/playbooks/${pb.id}`, undefined, OTHER);
    expect([res.statusCode, res.json().error.code]).toEqual([404, "PLAYBOOK_NOT_FOUND"]);
    expect((await h.inject("DELETE", `/v1/playbooks/${pb.id}`, undefined, OTHER)).statusCode).toBe(
      404,
    );
  });

  it("DELETE cancels a running playbook and deletes a finished one", async () => {
    const h = (current = setup({ autoRun: false }));
    const { id } = (await h.create({ source: { channel: "@mockgolden01" } })).json();
    expect((await h.inject("DELETE", `/v1/playbooks/${id}`)).statusCode).toBe(204);
    expect((await h.inject("GET", `/v1/playbooks/${id}`)).json().status).toBe("cancelled");
    await h.drain(); // the queued job sees the cancel and does nothing
    expect((await h.store.get(id))!.status).toBe("cancelled");
    // A new request isn't attached to the cancelled one.
    const again = await h.create({ source: { channel: "@mockgolden01" } });
    expect(again.json().id).not.toBe(id);
    expect((await h.inject("DELETE", `/v1/playbooks/${id}`)).statusCode).toBe(204);
    expect((await h.inject("GET", `/v1/playbooks/${id}`)).statusCode).toBe(404);
  });

  it("streams playbook events in stage order and closes when it finishes", async () => {
    const h = (current = setup({ autoRun: false }));
    const base = await h.app.listen({ port: 0, host: "127.0.0.1" });
    const { id } = (await h.create({ source: { channel: "@mockgolden01" } })).json();
    const stream = fetch(`${base}/v1/playbooks/${id}/events`, { headers: AUTH }).then((r) =>
      r.text(),
    );
    await new Promise((r) => setTimeout(r, 50));
    await h.drain();
    const events = (await stream)
      .split("\n\n")
      .filter((b) => b.startsWith("event:"))
      .map((b) => {
        const [e, d] = b.split("\n");
        return { event: e!.slice(7), data: JSON.parse(d!.slice(6)) as PlaybookResponse };
      });
    expect(events.every((e) => e.event === "playbook")).toBe(true);
    const stages = events.map((e) => e.data.stage).filter(Boolean);
    expect(stages.indexOf("watching")).toBeLessThan(stages.indexOf("writing_playbook"));
    expect(events.at(-1)!.data.status).toBe("succeeded");
  });
});

describe("POST /v1/playbooks/{id}/apply", () => {
  it("returns a prompt and shot list that pass v1's checks, then serves repeats from cache", async () => {
    const h = (current = setup());
    const pb = await h.finished();
    const body = {
      goal: "a 30-second video about my coffee cart",
      target: { format: "9:16", length_seconds: 30 },
    };
    const res = await h.inject("POST", `/v1/playbooks/${pb.id}/apply`, body);
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.cardboard_prompt).toContain("my coffee cart");
    expect(out.cardboard_prompt.split(/\s+/).length).toBeGreaterThanOrEqual(150);
    expect(out.shot_list).toHaveLength(4);
    expect(out.meta).toMatchObject({ prompt_version: "ap1", cached: false });
    const again = await h.inject("POST", `/v1/playbooks/${pb.id}/apply`, body);
    expect(again.json().meta.cached).toBe(true);
    expect(h.analyzer.calls.filter((c) => c.method === "applyPlaybook")).toHaveLength(1);
  });

  it("refuses unfinished, empty and invalid requests", async () => {
    const h = (current = setup({ autoRun: false }));
    const { id } = (await h.create({ source: { channel: "@mockgolden01" } })).json();
    const notReady = await h.inject("POST", `/v1/playbooks/${id}/apply`, {});
    expect([notReady.statusCode, notReady.json().error.code]).toEqual([409, "PLAYBOOK_NOT_READY"]);
    await h.drain();
    const tooLong = await h.inject("POST", `/v1/playbooks/${id}/apply`, { goal: "x".repeat(1501) });
    expect(tooLong.json().error.code).toBe("GOAL_TOO_LONG");
    const bad = await h.inject("POST", `/v1/playbooks/${id}/apply`, { target: { format: "3:2" } });
    expect(bad.json().error.code).toBe("INVALID_REQUEST");
    const rec = (await h.store.get(id))!;
    await h.store.update(id, { content: { ...rec.content!, rules: [] } });
    const empty = await h.inject("POST", `/v1/playbooks/${id}/apply`, {});
    expect([empty.statusCode, empty.json().error.code]).toEqual([422, "PLAYBOOK_HAS_NO_RULES"]);
  });

  it("an upstream failure gives the regenerate slot back", async () => {
    const h = (current = setup());
    const pb = await h.finished();
    const refund = vi.spyOn(h.limiter, "refund");
    const res = await h.inject("POST", `/v1/playbooks/${pb.id}/apply`, {
      goal: `about ${MOCK_FAULT_IDS.pass2Fails}`,
    });
    expect([res.statusCode, res.json().error.code]).toEqual([502, "UPSTREAM_ERROR"]);
    expect(refund).toHaveBeenCalledWith("regenerate", expect.anything(), expect.any(Date));
  });
});

describe("/v1/skills", () => {
  it("saves a playbook as a skill, lists it, applies it after the playbook is gone", async () => {
    const h = (current = setup());
    const pb = await h.finished();
    const saved = await h.inject("POST", "/v1/skills", {
      name: "  Coffee   hooks ",
      source: { playbook_id: pb.id },
    });
    expect(saved.statusCode).toBe(201);
    const skill = saved.json() as SkillResponse;
    expect(skill).toMatchObject({
      name: "Coffee hooks",
      source: { type: "playbook", id: pb.id, title: pb.channel!.title },
      last_used_at: null,
      snapshot: { type: "playbook", rules: pb.rules },
    });
    expect(JSON.stringify(skill)).not.toMatch(/spokenFingerprints|spoken_fingerprints|spokenLines/);

    // The playbook is deleted; the skill still applies.
    await h.inject("DELETE", `/v1/playbooks/${pb.id}`);
    const applied = await h.inject("POST", `/v1/skills/${skill.id}/apply`, { goal: "my bakery" });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().cardboard_prompt).toContain("my bakery");

    const list = (await h.inject("GET", "/v1/skills")).json();
    expect(list.skills).toHaveLength(1);
    expect(list.skills[0].last_used_at).not.toBeNull();
    expect(list.skills[0].snapshot).toBeUndefined();
    expect((await h.inject("GET", `/v1/skills/${skill.id}`)).json().snapshot.type).toBe("playbook");
    expect((await h.inject("GET", `/v1/skills/${skill.id}`, undefined, OTHER)).statusCode).toBe(
      404,
    );
    expect((await h.inject("DELETE", `/v1/skills/${skill.id}`)).statusCode).toBe(204);
    expect((await h.inject("GET", "/v1/skills")).json().skills).toEqual([]);
  });

  it("saves a brief as a skill and applies it with pass 2", async () => {
    const h = (current = setup());
    const brief = (
      await h.inject("POST", "/v1/briefs", { source: { url: MOCK_VIDEOS.short.id } })
    ).json();
    await h.idle();
    const saved = await h.inject("POST", "/v1/skills", {
      name: "Talking head",
      source: { brief_id: brief.id },
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().snapshot).toMatchObject({ type: "brief", video_id: MOCK_VIDEOS.short.id });
    const applied = await h.inject("POST", `/v1/skills/${saved.json().id}/apply`, {
      goal: "my gym",
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().meta.prompt_version).toMatch(/^p2\./);
    expect(applied.json().shot_list.length).toBeGreaterThanOrEqual(4);
  });

  it("refuses unknown, unfinished or empty sources, bad names and the 51st skill", async () => {
    const h = (current = setup({ autoRun: false }));
    const save = (body: unknown, headers: Headers = AUTH) =>
      h.inject("POST", "/v1/skills", body, headers);
    expect(
      (await save({ name: "x", source: { playbook_id: "pbk_missing" } })).json().error.code,
    ).toBe("PLAYBOOK_NOT_FOUND");
    expect((await save({ name: "x", source: { brief_id: "brf_missing" } })).json().error.code).toBe(
      "BRIEF_NOT_FOUND",
    );
    const { id } = (await h.create({ source: { channel: "@mockgolden01" } })).json();
    expect((await save({ name: "x", source: { playbook_id: id } })).json().error.code).toBe(
      "PLAYBOOK_NOT_READY",
    );
    expect((await save({ name: "x", source: { playbook_id: id } }, OTHER)).json().error.code).toBe(
      "PLAYBOOK_NOT_FOUND",
    );
    await h.drain();
    const rec = (await h.store.get(id))!;
    await h.store.update(id, { content: { ...rec.content!, rules: [] } });
    expect((await save({ name: "x", source: { playbook_id: id } })).json().error.code).toBe(
      "PLAYBOOK_HAS_NO_RULES",
    );
    expect((await save({ name: "​", source: { playbook_id: id } })).json().error.code).toBe(
      "INVALID_REQUEST",
    );
    await h.store.update(id, { content: rec.content });
    for (let i = 0; i < SKILLS_PER_USER; i++) {
      await h.skills.create(
        skillRecord({ id: `sk_fill_${i}`, userId: "dev-user" }),
        SKILLS_PER_USER,
      );
    }
    const full = await save({ name: "one more", source: { playbook_id: id } });
    expect([full.statusCode, full.json().error.code]).toEqual([409, "SKILL_LIMIT_REACHED"]);
    expect(full.json().error.message).toContain("50");
  });
});

describe("review fixes (M10.7)", () => {
  it("at the daily limit, a repeat (200) and an attach (202) still work", async () => {
    const h = (current = setup({ playbooksPerDay: 1 }));
    const first = await h.finished({ source: { channel: "@mockgolden01" } });
    const repeat = await h.create({ source: { channel: "@mockgolden01" } });
    expect([repeat.statusCode, repeat.json().id]).toEqual([200, first.id]);
    expect((await h.create({ source: { channel: "@mockgolden02" } })).statusCode).toBe(429);
  });

  it("bad input still counts toward the limit", async () => {
    const h = (current = setup({ playbooksPerDay: 2 }));
    await h.create({ source: { channel: "@mockgone" } });
    await h.create({ source: { channel: "not a channel" } });
    expect((await h.create({ source: { channel: "@mockgolden01" } })).statusCode).toBe(429);
  });

  it("a double click starts one job", async () => {
    const h = (current = setup({ autoRun: false }));
    const [a, b] = await Promise.all([
      h.create({ source: { channel: "@mockgolden05" } }),
      h.create({ source: { channel: "@mockgolden05" } }),
    ]);
    expect(a.json().id).toBe(b.json().id);
    expect(h.pbQueue.jobs).toHaveLength(1);
  });

  it("failed or cancelled playbooks answer apply and save with a non-retryable code", async () => {
    const h = (current = setup());
    const pb = await h.finished({ source: { channel: "@mocktiny" } });
    for (const res of [
      await h.inject("POST", `/v1/playbooks/${pb.id}/apply`, {}),
      await h.inject("POST", "/v1/skills", { name: "x", source: { playbook_id: pb.id } }),
    ]) {
      expect([res.statusCode, res.json().error]).toEqual([
        409,
        expect.objectContaining({ code: "PLAYBOOK_NOT_AVAILABLE", retryable: false }),
      ]);
    }
  });

  it("polling apply on a running playbook doesn't use regenerate slots", async () => {
    const h = (current = setup({ autoRun: false }));
    const take = vi.spyOn(h.limiter, "take");
    const { id } = (await h.create({ source: { channel: "@mockgolden01" } })).json();
    take.mockClear();
    for (let i = 0; i < 3; i++) {
      expect((await h.inject("POST", `/v1/playbooks/${id}/apply`, {})).json().error.code).toBe(
        "PLAYBOOK_NOT_READY",
      );
    }
    expect(take).not.toHaveBeenCalled();
  });

  it("apply output that stays invalid keeps the slot and counts toward spend", async () => {
    const spend = new SpendTracker(new MemoryKV(), { capUsd: 100 });
    const h = (current = setup({ app: { spend }, pricing: loadPricing() }));
    const pb = await h.finished();
    const refund = vi.spyOn(h.limiter, "refund");
    h.analyzer.applyPlaybook = async (input) => ({
      output: {},
      model: input.model,
      usage: { inputTokens: 5000, outputTokens: 500 },
    });
    h.analyzer.repair = async (input) => ({
      output: {},
      model: input.model,
      usage: { inputTokens: 5000, outputTokens: 500 },
    });
    const res = await h.inject("POST", `/v1/playbooks/${pb.id}/apply`, { goal: "x" });
    expect(res.json().error.code).toBe("INVALID_MODEL_OUTPUT");
    expect(refund).not.toHaveBeenCalledWith("regenerate", expect.anything(), expect.anything());
    expect(await spend.today()).toBeGreaterThan(0);
  });

  it("the apply cache is keyed by language too", async () => {
    const h = (current = setup());
    const pb = await h.finished();
    await h.inject("POST", `/v1/playbooks/${pb.id}/apply`, { goal: "x", output_language: "en" });
    await h.inject("POST", `/v1/playbooks/${pb.id}/apply`, { goal: "x", output_language: "es" });
    await h.inject("POST", `/v1/playbooks/${pb.id}/apply`, { goal: "x", output_language: "es" });
    expect(h.analyzer.calls.filter((c) => c.method === "applyPlaybook")).toHaveLength(2);
  });

  it("other users get not-found everywhere", async () => {
    const h = (current = setup());
    const pb = await h.finished();
    const skill = (
      await h.inject("POST", "/v1/skills", { name: "Mine", source: { playbook_id: pb.id } })
    ).json();
    const brief = (
      await h.inject("POST", "/v1/briefs", { source: { url: MOCK_VIDEOS.short.id } })
    ).json();
    await h.idle();
    const cases: [string, string, unknown, string][] = [
      ["GET", `/v1/playbooks/${pb.id}/events`, undefined, "PLAYBOOK_NOT_FOUND"],
      ["POST", `/v1/playbooks/${pb.id}/apply`, {}, "PLAYBOOK_NOT_FOUND"],
      ["GET", `/v1/skills/${skill.id}`, undefined, "SKILL_NOT_FOUND"],
      ["POST", `/v1/skills/${skill.id}/apply`, {}, "SKILL_NOT_FOUND"],
      ["DELETE", `/v1/skills/${skill.id}`, undefined, "SKILL_NOT_FOUND"],
      ["POST", "/v1/skills", { name: "x", source: { brief_id: brief.id } }, "BRIEF_NOT_FOUND"],
    ];
    for (const [method, url, body, code] of cases) {
      const res = await h.inject(method as "GET", url, body, OTHER);
      expect([res.statusCode, res.json().error.code], `${method} ${url}`).toEqual([404, code]);
    }
    // The same idempotency key from another user is a different request.
    const k = { "idempotency-key": "shared-key" };
    const mine = await h.create({ source: { channel: "@mockgolden07" } }, { ...AUTH, ...k });
    const theirs = await h.create({ source: { channel: "@mockgolden07" } }, { ...OTHER, ...k });
    expect(theirs.json().id).not.toBe(mine.json().id);
    expect((await h.inject("GET", "/v1/skills", undefined, OTHER)).json().skills).toEqual([]);
  });

  it("if live updates can't start, the stream ends with an error event", async () => {
    const h = (current = setup());
    const pb = await h.finished();
    h.deps.events.subscribe = async () => {
      throw new Error("redis down");
    };
    const base = await h.app.listen({ port: 0, host: "127.0.0.1" });
    const text = await fetch(`${base}/v1/playbooks/${pb.id}/events`, { headers: AUTH }).then((r) =>
      r.text(),
    );
    expect(text).toContain("event: error");
    expect(text).toContain('"code":"INTERNAL"');
  });
});
