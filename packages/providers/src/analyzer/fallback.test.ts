import { MatchCutError } from "@match-cut/core";
import { describe, expect, it, vi } from "vitest";
import { JobBudget } from "./budget.js";
import { attemptPlan, isRetryable, withFallback } from "./fallback.js";
import { MockAnalyzer } from "./mock.js";
import type { CallContext, ModelResult, VideoAnalyzer, WatchInput } from "./types.js";

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
  extractFeatures: mock.extractFeatures.bind(mock),
  writePlaybook: mock.writePlaybook.bind(mock),
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

describe("withFallback when a model is overloaded (incident 2026-11-18)", () => {
  const fallbackOpts = {
    fallbacks: ["lite"],
    skipSameModelOnOverload: true,
    fallbackReserveMs: 40_000,
    minAttemptMs: 8_000,
    ...noSleep,
  };
  /** A job budget on a fake clock that each call can move forward. */
  function clock(timeoutMs = 240_000) {
    let t = 0;
    const budget = new JobBudget({ maxFailedAttempts: 4, timeoutMs, now: () => t });
    return { budget, advance: (ms: number) => (t += ms) };
  }

  it("503 goes straight to the next model instead of retrying the same one", async () => {
    const { inner, calls } = scripted([overloaded(), "ok"]);
    const r = await withFallback(inner, fallbackOpts).watch(input);
    expect(calls).toEqual(["flash", "lite"]);
    expect(r).toMatchObject({ model: "lite", fallbackUsed: true });
  });

  it("a 504 from an overloaded model also goes straight to the next model", async () => {
    const gatewayTimeout = () => new MatchCutError("UPSTREAM_ERROR", {}, { status: 504 });
    const { inner, calls } = scripted([gatewayTimeout(), "ok"]);
    await withFallback(inner, fallbackOpts).watch(input);
    expect(calls).toEqual(["flash", "lite"]);
  });

  it("a 500 still retries the same model once", async () => {
    const serverError = () => new MatchCutError("UPSTREAM_ERROR", {}, { status: 500 });
    const { inner, calls } = scripted([serverError(), "ok"]);
    await withFallback(inner, fallbackOpts).watch(input);
    expect(calls).toEqual(["flash", "flash"]);
  });

  it("with no other model left, a 503 still retries the same model", async () => {
    const { inner, calls } = scripted([overloaded(), "ok"]);
    await withFallback(inner, { ...fallbackOpts, fallbacks: [] }).watch(input);
    expect(calls).toEqual(["flash", "flash"]);
  });

  it("caps an attempt so the fallback keeps its reserve, and the last model gets the rest", async () => {
    const { budget } = clock(100_000);
    const seen: number[] = [];
    const inner = analyzerWith({
      watch: vi.fn(async (i: WatchInput, _s?: AbortSignal, ctx?: CallContext) => {
        seen.push(ctx!.timeoutMs!);
        if (i.model === "flash") throw overloaded();
        return ok(i.model);
      }),
    });
    await withFallback(inner, fallbackOpts).watch(input, undefined, { budget });
    expect(seen).toEqual([60_000, 100_000]);
  });

  it("leaves reserveAfterMs untouched for the next stage", async () => {
    const { budget } = clock(100_000);
    const seen: number[] = [];
    const inner = analyzerWith({
      watch: vi.fn(async (i: WatchInput, _s?: AbortSignal, ctx?: CallContext) => {
        seen.push(ctx!.timeoutMs!);
        return ok(i.model);
      }),
    });
    await withFallback(inner, fallbackOpts).watch(input, undefined, {
      budget,
      reserveAfterMs: 25_000,
    });
    expect(seen).toEqual([35_000]); // 100 - 25 reserved for pass 2 - 40 kept for "lite"
  });

  it("doesn't start an attempt with too little time left", async () => {
    const { budget, advance } = clock(50_000);
    const calls: string[] = [];
    const inner = analyzerWith({
      watch: vi.fn(async (i: WatchInput) => {
        calls.push(i.model);
        advance(45_000); // the overloaded call hangs for most of the budget
        throw overloaded();
      }),
    });
    const err = await withFallback(inner, fallbackOpts)
      .watch(input, undefined, { budget })
      .catch((e: MatchCutError) => e);
    expect(calls).toEqual(["flash"]); // 5 s left < 8 s minimum: "lite" is never called
    expect((err as MatchCutError).error.code).toBe("UPSTREAM_TIMEOUT");
  });
});

describe("withFallback when every model is overloaded (incident 2026-11-23)", () => {
  const opts = {
    fallbacks: ["lite"],
    skipSameModelOnOverload: true,
    fallbackReserveMs: 40_000,
    minAttemptMs: 8_000,
    overloadRoundWaitsMs: [5_000, 15_000],
  };
  const budgetOf = (timeoutMs: number) =>
    new JobBudget({ maxFailedAttempts: 10, timeoutMs, now: () => 0 });

  it("both models busy: waits, goes round again, and the second round answers", async () => {
    const sleep = vi.fn(async () => {});
    const { inner, calls } = scripted([overloaded(), overloaded(), "ok"]);
    const r = await withFallback(inner, { ...opts, sleep }).watch(input, undefined, {
      budget: budgetOf(140_000),
    });
    expect(calls).toEqual(["flash", "lite", "flash"]);
    expect(r).toMatchObject({ model: "flash", attempts: 3 });
    expect(sleep.mock.calls.map((c) => (c as unknown as [number])[0])).toContain(5_000);
  });

  it("stops after the last round and returns the overload error", async () => {
    const { inner, calls } = scripted(Array.from({ length: 6 }, overloaded));
    const err = await withFallback(inner, { ...opts, ...noSleep })
      .watch(input, undefined, { budget: budgetOf(200_000) })
      .catch((e: MatchCutError) => e);
    expect(calls).toEqual(["flash", "lite", "flash", "lite", "flash", "lite"]);
    expect((err as MatchCutError).detail).toMatchObject({ status: 503 });
  });

  it("doesn't go round again for errors that aren't overload", async () => {
    const serverError = () => new MatchCutError("UPSTREAM_ERROR", {}, { status: 500 });
    const { inner, calls } = scripted([serverError(), serverError(), serverError()]);
    await withFallback(inner, { ...opts, ...noSleep })
      .watch(input, undefined, { budget: budgetOf(200_000) })
      .catch(() => undefined);
    expect(calls).toEqual(["flash", "flash", "lite"]);
  });

  it("doesn't wait for a round the job budget can't fit", async () => {
    const sleep = vi.fn(async () => {});
    const { inner, calls } = scripted([overloaded(), overloaded(), "ok"]);
    await withFallback(inner, { ...opts, sleep })
      .watch(input, undefined, { budget: budgetOf(10_000) }) // 10 s - 5 s wait < 8 s minimum
      .catch(() => undefined);
    expect(calls).toEqual(["flash", "lite"]);
  });

  it("without the option, all-busy still gives up after one pass", async () => {
    const { inner, calls } = scripted([overloaded(), overloaded(), "ok"]);
    await withFallback(inner, { ...opts, overloadRoundWaitsMs: [], ...noSleep })
      .watch(input, undefined, { budget: budgetOf(140_000) })
      .catch(() => undefined);
    expect(calls).toEqual(["flash", "lite"]);
  });
});

describe("extractFeatures (PRD-playbooks.md) rides the same chain", () => {
  const fx = { videoId: "mockShort01", breakdown: {} as never, model: "flash" };

  it("an overloaded model falls back like the other calls", async () => {
    const inner = analyzerWith({
      extractFeatures: vi
        .fn()
        .mockRejectedValueOnce(overloaded())
        .mockRejectedValueOnce(overloaded())
        .mockResolvedValue(ok("x")),
    });
    const r = await withFallback(inner, { fallbacks: ["flash-old"], ...noSleep }).extractFeatures(
      fx,
    );
    expect(r).toMatchObject({ model: "flash-old", fallbackUsed: true });
  });

  it("mock fault injection works for the new method", async () => {
    const m = new MockAnalyzer({ faults: { extractFeatures: [{ output: { hook_type: "x" } }] } });
    const r = await m.extractFeatures(fx);
    expect(r.output).toEqual({ hook_type: "x" });
    expect(m.calls.map((c) => c.method)).toEqual(["extractFeatures"]);
  });
});

describe("writePlaybook (PRD-playbooks.md) rides the same chain", () => {
  const fx = { facts: {} as never, manifest: {} as never, language: "en", model: "flash" };

  it("an overloaded model falls back like the other calls", async () => {
    const inner = analyzerWith({
      writePlaybook: vi
        .fn()
        .mockRejectedValueOnce(overloaded())
        .mockRejectedValueOnce(overloaded())
        .mockResolvedValue(ok("x")),
    });
    const r = await withFallback(inner, { fallbacks: ["flash-old"], ...noSleep }).writePlaybook(fx);
    expect(r).toMatchObject({ model: "flash-old", fallbackUsed: true });
  });

  it("mock fault injection works for the new method", async () => {
    const m = new MockAnalyzer({ faults: { writePlaybook: [{ output: { rules: "x" } }] } });
    const r = await m.writePlaybook(fx);
    expect(r.output).toEqual({ rules: "x" });
    expect(m.calls.map((c) => c.method)).toEqual(["writePlaybook"]);
  });
});
