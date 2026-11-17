/** PRD "Rate limits and quotas", daily spend cap, cache layers and logging rules. */
import { loadPricing } from "@match-cut/core";
import {
  decryptText,
  defaultRules,
  encryptText,
  goalKeyFrom,
  MemoryBriefStore,
  MemoryKV,
  RateLimiter,
  SpendTracker,
} from "@match-cut/infra";
import {
  CachedVideoLookup,
  MOCK_FAULT_IDS,
  MOCK_VIDEOS,
  MockAnalyzer,
  MockVideoLookup,
  withFallback,
} from "@match-cut/providers";
import { describe, expect, it, vi } from "vitest";
import { harness } from "./helpers.js";

const SHORT = MOCK_VIDEOS.short.id;
const rules = (over: Partial<Parameters<typeof defaultRules>[0]> = {}) =>
  defaultRules({
    userPerHour: 20,
    userPerDay: 100,
    regeneratePerHour: 60,
    orgPerDay: 1000,
    ...over,
  });

function limited(over: Parameters<typeof rules>[0] = {}, clock = () => Date.now()) {
  const kv = new MemoryKV(clock);
  const limiter = new RateLimiter(kv, rules(over), clock);
  return { kv, limiter, h: harness({ app: { kv, limiter }, pipeline: { limiter } }) };
}

describe("rate limits", () => {
  it("per user per hour: RATE_LIMITED with Retry-After and the PRD message", async () => {
    const { h } = limited({ userPerHour: 2 });
    for (let i = 0; i < 2; i++)
      expect((await h.post({ source: { url: SHORT }, goal: `g${i}` })).statusCode).toBeLessThan(
        300,
      );
    const res = await h.post({ source: { url: SHORT }, goal: "third" });
    expect(res.statusCode).toBe(429);
    const retryAfter = Number(res.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(res.json().error).toEqual({
      code: "RATE_LIMITED",
      message: `You've reached the limit for now. You can match another video in ${Math.ceil(retryAfter / 60)} minutes.`,
      retryable: true,
    });
  });

  it("bad-input failures count toward the limit", async () => {
    const { h } = limited({ userPerHour: 2 });
    expect((await h.post({ source: { url: "not a link" } })).statusCode).toBe(400);
    expect((await h.post({ source: { url: MOCK_VIDEOS.private.id } })).statusCode).toBe(422);
    expect((await h.post({ source: { url: SHORT } })).statusCode).toBe(429);
  });

  it("limits are per user, and idempotent replays don't count", async () => {
    const { h } = limited({ userPerHour: 1 });
    await h.post({ source: { url: SHORT } }, { "idempotency-key": "a" });
    expect(
      (await h.post({ source: { url: SHORT } }, { "idempotency-key": "a" })).statusCode,
    ).toBeLessThan(300);
    expect(
      (await h.post({ source: { url: SHORT } }, { "x-dev-user-id": "other" })).statusCode,
    ).toBeLessThan(300);
  });

  it("per user per day, and per org per day", async () => {
    expect(
      (
        await (async () => {
          const { h } = limited({ userPerDay: 1 });
          await h.post({ source: { url: SHORT } });
          return h.post({ source: { url: SHORT }, goal: "x" });
        })()
      ).statusCode,
    ).toBe(429);
    const { h } = limited({ orgPerDay: 1 });
    await h.post({ source: { url: SHORT } }, { "x-dev-user-id": "u1" });
    expect((await h.post({ source: { url: SHORT } }, { "x-dev-user-id": "u2" })).statusCode).toBe(
      429,
    );
  });

  it("regenerate has its own limit", async () => {
    const { h } = limited({ regeneratePerHour: 1 });
    const { id } = (await h.post({ source: { url: SHORT } })).json();
    await h.idle();
    expect((await h.regenerate(id, { goal: "a" })).statusCode).toBeLessThan(300);
    await h.idle();
    expect((await h.regenerate(id, { goal: "b" })).statusCode).toBe(429);
  });

  it("failed jobs are not billed to the quota", async () => {
    const analyzer = withFallback(new MockAnalyzer(), { fallbacks: [], sleep: async () => {} });
    const kv = new MemoryKV();
    const lim = new RateLimiter(kv, rules({ userPerHour: 1 }));
    const h = harness({ analyzer, app: { kv, limiter: lim }, pipeline: { limiter: lim } });
    const failed = (await h.post({ source: { url: MOCK_FAULT_IDS.pass1Fails } })).json();
    await h.idle();
    expect((await h.brief(failed.id)).status).toBe("failed");
    expect((await h.post({ source: { url: SHORT } })).statusCode).toBeLessThan(300);
  });

  it("windows reset", async () => {
    let now = Date.UTC(2026, 10, 17, 10, 0, 0);
    const kv = new MemoryKV(() => now);
    const lim = new RateLimiter(kv, rules({ userPerHour: 1 }), () => now);
    const who = { userId: "u", orgId: "o" };
    expect((await lim.take("analyze", who)).ok).toBe(true);
    expect(await lim.take("analyze", who)).toMatchObject({
      ok: false,
      retryAfterSeconds: 3600,
      rule: "user-hour",
    });
    now += 3600_000;
    expect((await lim.take("analyze", who)).ok).toBe(true);
  });
});

describe("daily spend cap", () => {
  it("alerts at 70%, refuses new jobs at the cap, still serves cache hits", async () => {
    const kv = new MemoryKV();
    const alert = vi.fn();
    const spend = new SpendTracker(kv, { capUsd: 1, alert });
    await spend.add(0.71);
    expect(alert).toHaveBeenCalledWith(expect.stringMatching(/71% of the \$1 cap/));
    await spend.add(0.1);
    expect(alert).toHaveBeenCalledTimes(1); // once per day per level

    const h = harness({ app: { kv, spend }, pipeline: { spend, pricing: loadPricing() } });
    const first = await h.post({ source: { url: SHORT }, goal: "cached later" });
    expect(first.statusCode).toBe(202);
    await h.idle();
    await spend.add(0.5);
    expect(alert).toHaveBeenLastCalledWith(expect.stringMatching(/cap reached/));

    const refused = await h.post({ source: { url: SHORT }, goal: "new" });
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe("CAPACITY_EXHAUSTED");
    const hit = await h.post({ source: { url: SHORT }, goal: "cached later" });
    expect(hit.statusCode).toBe(200);
  });

  it("each job records its estimated cost from token counts", async () => {
    const kv = new MemoryKV();
    const spend = new SpendTracker(kv, { capUsd: 100 });
    const h = harness({ app: { kv }, pipeline: { spend, pricing: loadPricing() } });
    const { id } = (await h.post({ source: { url: SHORT } })).json();
    await h.idle();
    // Mock usage: pass 1 18,000 in / 1,200 out; pass 2 3,000 / 800; mock-flash $0.75 / $3.75.
    const expected = (21000 * 0.75 + 2000 * 3.75) / 1e6;
    expect((await h.deps.store.get(id))?.meta.costUsd).toBeCloseTo(expected, 8);
    expect(await spend.today()).toBeCloseTo(expected, 8);
  });
});

describe("cache layers", () => {
  it("precheck metadata is cached for 6 hours, found videos only", async () => {
    let now = 0;
    const kv = new MemoryKV(() => now);
    const inner = new MockVideoLookup();
    const spy = vi.spyOn(inner, "lookup");
    const cached = new CachedVideoLookup(inner, kv);
    await cached.lookup(SHORT);
    await cached.lookup(SHORT);
    expect(spy).toHaveBeenCalledTimes(1);
    now += 6 * 3600_000 + 1;
    await cached.lookup(SHORT);
    expect(spy).toHaveBeenCalledTimes(2);
    await cached.lookup("mockGone001");
    await cached.lookup("mockGone001");
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("pass 1 for 30 days and pass 2 for 7 days", async () => {
    const kv = new MemoryKV();
    const set = vi.spyOn(kv, "set");
    const h = harness({ app: { kv } });
    await h.post({ source: { url: SHORT } });
    await h.idle();
    const ttl = (prefix: string) => set.mock.calls.find(([k]) => k.startsWith(prefix))?.[2];
    expect(ttl("p1:")).toBe(30 * 86400);
    expect(ttl("p2:")).toBe(7 * 86400);
  });
});

describe("security and privacy", () => {
  it("goal text is encrypted with AES-256-GCM and round-trips", () => {
    const key = goalKeyFrom(Buffer.alloc(32, 7).toString("base64"), "x");
    const enc = encryptText("my secret launch plan", key);
    expect(enc).toMatch(/^v1:/);
    expect(enc).not.toContain("secret");
    expect(encryptText("my secret launch plan", key)).not.toBe(enc); // random IV
    expect(decryptText(enc, key)).toBe("my secret launch plan");
    expect(decryptText("legacy plaintext", key)).toBe("legacy plaintext");
    expect(() =>
      decryptText(enc, goalKeyFrom(Buffer.alloc(32, 8).toString("base64"), "x")),
    ).toThrow();
  });

  it("job logs never contain the goal text", async () => {
    const log = vi.fn();
    const h = harness({ pipeline: { log } });
    const goal = "PRIVATE-GOAL-TEXT about my unreleased product";
    await h.post({ source: { url: SHORT }, goal });
    await h.idle();
    const all = JSON.stringify(log.mock.calls);
    expect(all).not.toContain("PRIVATE-GOAL-TEXT");
    const finished = log.mock.calls.find(([m]) => m === "job finished")?.[1];
    expect(finished).toMatchObject({
      outcome: "succeeded",
      videoId: SHORT,
      cache: { pass1: false, pass2: false },
    });
    expect(Object.keys(finished)).not.toContain("goal");
  });

  it("retention deletes briefs older than the cutoff", async () => {
    const store = new MemoryBriefStore();
    const base = { userId: "u", orgId: "o", status: "succeeded" } as never;
    await store.create({
      ...(base as object),
      id: "old",
      createdAt: new Date("2026-01-01"),
    } as never);
    await store.create({
      ...(base as object),
      id: "new",
      createdAt: new Date("2026-11-01"),
    } as never);
    expect(await store.deleteOlderThan(new Date("2026-08-19"))).toBe(1);
    expect(await store.get("old")).toBeNull();
    expect(await store.get("new")).not.toBeNull();
  });
});

describe("key rotation", () => {
  it("reads goals written with a previous key, and survives a row no key can read", async () => {
    const { decryptWithAny, previousKeysFrom } = await import("@match-cut/infra");
    const oldKey = Buffer.alloc(32, 1);
    const newKey = Buffer.alloc(32, 2);
    const stored = encryptText("written before rotation", oldKey);
    expect(decryptWithAny(stored, [newKey, oldKey])).toBe("written before rotation");
    expect(decryptWithAny(stored, [newKey])).toBeNull();
    expect(previousKeysFrom(`${oldKey.toString("base64")}, not-a-key`)).toHaveLength(1);
  });
});
