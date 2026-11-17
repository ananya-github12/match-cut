import { MatchCutError } from "@match-cut/core";
import { describe, expect, it, vi } from "vitest";
import { attemptPlan, isRetryable, withFallback } from "./fallback.js";
import { MockAnalyzer } from "./mock.js";
import type { ModelResult, VideoAnalyzer, WatchInput } from "./types.js";

const input: WatchInput = {
  videoId: "mockShort01",
  canonicalUrl: "https://www.youtube.com/watch?v=mockShort01",
  range: null,
  detail: "standard",
  model: "flash",
  durationSeconds: 45,
};
const overloaded = () => new MatchCutError("UPSTREAM_ERROR", {}, { status: 503 });
const ok = (model: string): ModelResult => ({
  output: { ok: true },
  model,
  usage: { inputTokens: 1, outputTokens: 1 },
});

/** Inner analyzer whose watch() follows a script of outcomes per call. */
function scripted(outcomes: (Error | "ok")[]) {
  const calls: string[] = [];
  const inner = analyzerWith({
    watch: vi.fn(async (i: WatchInput) => {
      calls.push(i.model);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return ok(i.model);
    }),
  });
  return { inner, calls };
}
const noSleep = { sleep: async () => {} };
const mock = new MockAnalyzer();
/** A full VideoAnalyzer from the mock, with some methods replaced. */
const analyzerWith = (over: Partial<VideoAnalyzer>): VideoAnalyzer => ({
  watch: mock.watch.bind(mock),
  writePrompt: mock.writePrompt.bind(mock),
  repair: mock.repair.bind(mock),
  ...over,
});

describe("attemptPlan", () => {
  it("requested model twice, then fallbacks in order, within the budget", () => {
    expect(attemptPlan("flash", { fallbacks: ["flash-old", "lite"] })).toEqual([
      "flash",
      "flash",
      "flash-old",
      "lite",
    ]);
    expect(attemptPlan("flash", { fallbacks: ["flash-old", "lite"], maxAttempts: 3 })).toEqual([
      "flash",
      "flash",
      "flash-old",
    ]);
    expect(attemptPlan("flash", { fallbacks: ["flash", "lite"] })).toEqual([
      "flash",
      "flash",
      "lite",
    ]);
    expect(attemptPlan("pro", { fallbacks: ["lite"], retrySameModel: 0 })).toEqual(["pro", "lite"]);
  });
});

describe("isRetryable", () => {
  it("retries overload, rate limits and empty responses only", () => {
    expect(isRetryable(overloaded())).toBe(true);
    expect(isRetryable(new MatchCutError("CAPACITY_EXHAUSTED"))).toBe(true);
    expect(isRetryable(new MatchCutError("UPSTREAM_ERROR", {}, { reason: "empty_text" }))).toBe(
      true,
    );
    expect(
      isRetryable(new MatchCutError("UPSTREAM_ERROR", {}, { status: 403, clientError: true })),
    ).toBe(false);
    for (const code of ["CONTENT_BLOCKED", "INVALID_MODEL_OUTPUT", "UPSTREAM_TIMEOUT"] as const) {
      expect(isRetryable(new MatchCutError(code))).toBe(false);
    }
    expect(isRetryable(new Error("boom"))).toBe(false);
  });
});

describe("withFallback", () => {
  const opts = { fallbacks: ["flash-old", "lite"], ...noSleep };

  it("first try works: no retry, no fallback", async () => {
    const { inner, calls } = scripted(["ok"]);
    const r = await withFallback(inner, opts).watch(input);
    expect(calls).toEqual(["flash"]);
    expect(r).toMatchObject({ model: "flash", attempts: 1, fallbackUsed: false });
  });

  it("one 503: retries the same model after a backoff", async () => {
    const sleep = vi.fn(async () => {});
    const { inner, calls } = scripted([overloaded(), "ok"]);
    const r = await withFallback(inner, { ...opts, sleep }).watch(input);
    expect(calls).toEqual(["flash", "flash"]);
    expect(r).toMatchObject({ model: "flash", attempts: 2, fallbackUsed: false });
    const waited = (sleep.mock.calls[0] as unknown as [number])[0];
    expect(waited).toBeGreaterThanOrEqual(750);
    expect(waited).toBeLessThanOrEqual(1250);
  });

  it("the requested model stays overloaded: the next model in the chain answers", async () => {
    const { inner, calls } = scripted([overloaded(), overloaded(), "ok"]);
    const r = await withFallback(inner, opts).watch(input);
    expect(calls).toEqual(["flash", "flash", "flash-old"]);
    expect(r).toMatchObject({ model: "flash-old", attempts: 3, fallbackUsed: true });
  });

  it("walks the whole chain", async () => {
    const { inner, calls } = scripted([overloaded(), overloaded(), overloaded(), "ok"]);
    const r = await withFallback(inner, opts).watch(input);
    expect(calls).toEqual(["flash", "flash", "flash-old", "lite"]);
    expect(r.model).toBe("lite");
  });

  it("everything overloaded: the last error, with attempts and models in the detail", async () => {
    const { inner, calls } = scripted([overloaded(), overloaded(), overloaded(), overloaded()]);
    const err = await withFallback(inner, opts)
      .watch(input)
      .catch((e: MatchCutError) => e);
    expect(calls).toHaveLength(4);
    expect((err as MatchCutError).error.code).toBe("UPSTREAM_ERROR");
    expect((err as MatchCutError).detail).toMatchObject({
      attempts: 4,
      models: ["flash", "flash-old", "lite"],
    });
  });

  it("rate limits everywhere end as CAPACITY_EXHAUSTED", async () => {
    const limited = () => new MatchCutError("CAPACITY_EXHAUSTED", {}, { status: 429 });
    const { inner } = scripted([limited(), limited(), limited(), limited()]);
    await expect(withFallback(inner, opts).watch(input)).rejects.toMatchObject({
      error: { code: "CAPACITY_EXHAUSTED" },
    });
  });

  it("does not retry or fall back on content blocks or client errors", async () => {
    for (const err of [
      new MatchCutError("CONTENT_BLOCKED"),
      new MatchCutError("UPSTREAM_ERROR", {}, { status: 404, clientError: true }),
    ]) {
      const { inner, calls } = scripted([err, "ok"]);
      await expect(withFallback(inner, opts).watch(input)).rejects.toMatchObject({
        error: { code: err.error.code },
        detail: { attempts: 1 },
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("cancellation stops at once, even during a backoff", async () => {
    const c = new AbortController();
    const reason = new Error("cancelled");
    const { inner, calls } = scripted([overloaded(), "ok"]);
    const p = withFallback(inner, { fallbacks: ["lite"], backoffMs: [5000] }).watch(
      input,
      c.signal,
    );
    await new Promise((r) => setTimeout(r, 10));
    c.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(calls).toEqual(["flash"]);
  });

  it("repair and writePrompt use the same chain", async () => {
    const inner = analyzerWith({
      repair: vi
        .fn()
        .mockRejectedValueOnce(overloaded())
        .mockRejectedValueOnce(overloaded())
        .mockResolvedValue(ok("x")),
    });
    const r = await withFallback(inner, opts).repair({
      pass: 1,
      previousOutput: "{}",
      problems: [],
      model: "flash",
    });
    expect(r).toMatchObject({ model: "flash-old", fallbackUsed: true });
  });
});
