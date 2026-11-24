/** PRD "Dashboards and alerts": each signal fires at its threshold and stays quiet below it. */
import { computeSignals, PRD_THRESHOLDS, type BriefRecord } from "@match-cut/infra";
import { MOCK_VIDEOS, MockAnalyzer, withFallback } from "@match-cut/providers";
import { describe, expect, it, vi } from "vitest";
import { harness } from "./helpers.js";

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;
let n = 0;

function row(
  over: Omit<Partial<BriefRecord>, "meta"> & {
    ago?: number;
    meta?: Partial<BriefRecord["meta"]>;
  } = {},
): BriefRecord {
  const at = new Date(NOW - (over.ago ?? MIN));
  const { ago: _a, meta, ...rest } = over;
  return {
    id: `b${n++}`,
    userId: "u1",
    orgId: "o1",
    status: "succeeded",
    stage: null,
    videoId: "mockShort01",
    video: { title: "t", channel: "c", durationSeconds: 45, embeddable: true },
    range: null,
    detail: "standard",
    goal: "",
    targetFormat: "match",
    targetLengthSeconds: null,
    outputLanguage: "en",
    forceRefresh: false,
    breakdown: null,
    spokenLines: null,
    prompt: null,
    warnings: [],
    error: null,
    meta: {
      model: "m",
      pass2Model: "m",
      cached: false,
      timingsMs: { total: 20_000 },
      tokens: {},
      ...meta,
    },
    createdAt: at,
    updatedAt: at,
    ...rest,
  };
}
const signal = (rows: BriefRecord[], name: string, spend = 0) =>
  computeSignals({ rows, now: NOW, spendTodayUsd: spend, spendCapUsd: 5 }).find(
    (s) => s.name === name,
  )!;
const many = (k: number, f: (i: number) => BriefRecord) =>
  Array.from({ length: k }, (_, i) => f(i));

describe("ops signals", () => {
  it("job failure rate over 5% in 15 minutes, excluding user-caused errors", () => {
    const ok = many(18, () => row());
    const ours = many(2, () =>
      row({ status: "failed", error: { code: "UPSTREAM_ERROR", message: "", retryable: true } }),
    );
    expect(signal([...ok, ...ours], "job_failure_rate")).toMatchObject({ value: 0.1, alert: true });
    const userCaused = many(2, () =>
      row({ status: "failed", error: { code: "VIDEO_NOT_PUBLIC", message: "", retryable: false } }),
    );
    expect(signal([...ok, ...userCaused], "job_failure_rate")).toMatchObject({
      value: 0,
      alert: false,
    });
    const old = many(2, () =>
      row({
        ago: 20 * MIN,
        status: "failed",
        error: { code: "INTERNAL", message: "", retryable: true },
      }),
    );
    expect(signal([...ok, ...old], "job_failure_rate").alert).toBe(false);
    expect(signal(ours, "job_failure_rate").alert).toBe(false); // too few jobs to judge
  });

  it("p95 latency over 60 s for videos up to 3 minutes, in 30 minutes", () => {
    const fast = many(18, () => row({ meta: { timingsMs: { total: 20_000 } } }));
    const slow = many(2, () => row({ meta: { timingsMs: { total: 90_000 } } }));
    expect(signal([...fast, ...slow], "p95_latency_ms_up_to_3min")).toMatchObject({
      value: 90_000,
      alert: true,
    });
    expect(signal(fast, "p95_latency_ms_up_to_3min").alert).toBe(false);
    const longVideos = many(10, () =>
      row({
        video: { title: "", channel: "", durationSeconds: 600, embeddable: true },
        meta: { timingsMs: { total: 90_000 } },
      }),
    );
    expect(signal([...fast, ...longVideos], "p95_latency_ms_up_to_3min").alert).toBe(false);
    const cached = many(10, () => row({ meta: { cached: true, timingsMs: { total: 90_000 } } }));
    expect(signal([...fast, ...cached], "p95_latency_ms_up_to_3min").alert).toBe(false);
  });

  it("repair-call rate over 10% for an hour", () => {
    const runs = [...many(8, () => row()), ...many(2, () => row({ meta: { repairUsed: true } }))];
    expect(signal(runs, "repair_rate")).toMatchObject({ value: 0.2, alert: true });
    expect(
      signal([...many(19, () => row()), row({ meta: { repairUsed: true } })], "repair_rate").alert,
    ).toBe(false);
  });

  it("Gemini rate-limit pressure (stand-in for quota used)", () => {
    const limited = many(3, () =>
      row({
        meta: { upstreamFailures: [{ model: "m", code: "CAPACITY_EXHAUSTED", status: 429 }] },
      }),
    );
    expect(signal([...many(7, () => row()), ...limited], "gemini_rate_limit_share")).toMatchObject({
      value: 0.3,
      alert: true,
    });
  });

  it("daily spend over 70% of the cap", () => {
    expect(signal([], "daily_spend_fraction", 3.6)).toMatchObject({ value: 0.72, alert: true });
    expect(signal([], "daily_spend_fraction", 3.4).alert).toBe(false);
  });

  it("CONTENT_BLOCKED or RECITATION doubling week over week", () => {
    const blocked = (ago: number) =>
      row({
        ago,
        status: "failed",
        error: { code: "CONTENT_BLOCKED", message: "", retryable: false },
      });
    const recitation = (ago: number) =>
      row({
        ago,
        meta: {
          upstreamFailures: [
            { model: "m", code: "INVALID_MODEL_OUTPUT", finishReason: "RECITATION" },
          ],
        },
      });
    const lastWeek = many(3, () => blocked(8 * DAY));
    const thisWeek = [...many(4, () => blocked(DAY)), ...many(2, () => recitation(2 * DAY))];
    expect(signal([...lastWeek, ...thisWeek], "blocked_or_recitation_wow")).toMatchObject({
      value: 2,
      alert: true,
    });
    expect(
      signal([...lastWeek, ...many(4, () => blocked(DAY))], "blocked_or_recitation_wow").alert,
    ).toBe(false);
  });

  it("abuse: an account over 5x the typical daily volume", () => {
    const typicalWeek = ["a", "b", "c"].flatMap((u) =>
      many(21, (i) => row({ userId: u, ago: 2 * DAY + i * 3600_000 })),
    );
    const spike = many(40, () => row({ userId: "spammer", ago: 2 * 3600_000 }));
    expect(signal([...typicalWeek, ...spike], "abuse_accounts")).toMatchObject({
      value: 1,
      alert: true,
    });
    expect(
      signal([...typicalWeek, ...many(10, () => row({ userId: "normal" }))], "abuse_accounts")
        .alert,
    ).toBe(false);
  });

  it("uses the PRD thresholds", () => {
    expect(PRD_THRESHOLDS).toMatchObject({
      failureRate: 0.05,
      p95LatencyMs: 60_000,
      repairRate: 0.1,
      spendFraction: 0.7,
      abuseMultiple: 5,
    });
  });
});

describe("logged per job (PRD list)", () => {
  it("has versions, cache hits, timings, tokens, cost, attempts, finish reasons, repair and warnings, never the goal", async () => {
    const log = vi.fn();
    const analyzer = withFallback(
      new MockAnalyzer({ faults: { watch: [{ finishReason: "RECITATION" }] } }),
      {
        fallbacks: [],
        sleep: async () => {},
      },
    );
    const h = harness({ analyzer, pipeline: { log } });
    await h.post({ source: { url: MOCK_VIDEOS.short.id }, goal: "SECRET-GOAL" });
    await h.idle();
    const line = log.mock.calls.find(([m]) => m === "job finished")![1];
    expect(line).toMatchObject({
      outcome: "succeeded",
      userId: "dev-user",
      orgId: "dev-org",
      videoId: "mockShort01",
      durationSeconds: 45,
      detail: "standard",
      model: "mock-flash",
      versions: {
        pass1Prompt: "p1.v1",
        pass2Prompt: "p2.v3",
        schema: "s1",
        manifest: "0-placeholder",
      },
      cache: { pass1: false, pass2: false },
      finishReasons: ["RECITATION"],
      upstreamFailures: [
        { model: "mock-flash", code: "INVALID_MODEL_OUTPUT", finishReason: "RECITATION" },
      ],
      repairUsed: false,
      warnings: [],
    });
    expect(line.tokens).toMatchObject({ pass1_input: 18000, pass2_input: 3000 });
    expect(line.timingsMs.total).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET-GOAL");
    // The failure is kept on the brief for the ops signals.
    const id = (await h.deps.store.listUpdatedSince(new Date(0)))[0]!.id;
    expect((await h.deps.store.get(id))!.meta.upstreamFailures).toHaveLength(1);
  });
});
