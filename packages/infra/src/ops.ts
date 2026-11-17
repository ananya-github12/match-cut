/**
 * Ops signals and alerts. PRD "Dashboards and alerts", computed from recent briefs. Pure: the
 * worker feeds it rows every few minutes and logs ALERT lines; `pnpm ops:report` prints it.
 * A production setup would ship the per-job log lines to a metrics backend instead; the
 * thresholds below are the PRD's.
 */
import type { BriefRecord } from "./types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Failures the user controls (bad links, private or blocked videos): excluded from the failure rate. */
const USER_CAUSED = new Set([
  "INVALID_URL",
  "UNSUPPORTED_SOURCE",
  "INVALID_CLIP_RANGE",
  "GOAL_TOO_LONG",
  "VIDEO_NOT_FOUND",
  "VIDEO_NOT_PUBLIC",
  "VIDEO_RESTRICTED",
  "LIVE_NOT_SUPPORTED",
  "VIDEO_TOO_LONG",
  "NO_ANALYZABLE_CONTENT",
  "CONTENT_BLOCKED",
]);

export interface OpsThresholds {
  failureRate: number; // PRD: over 5% for 15 minutes
  p95LatencyMs: number; // PRD: over 60 s for 30 minutes, videos up to 3 minutes
  repairRate: number; // PRD: over 10% for an hour
  spendFraction: number; // PRD: over 70% of the daily cap
  rateLimitShare: number; // stand-in for "Gemini quota used over 80%"
  abuseMultiple: number; // PRD security: over 5x typical volume
  minSample: number; // ignore windows with fewer jobs than this
}

export const PRD_THRESHOLDS: OpsThresholds = {
  failureRate: 0.05,
  p95LatencyMs: 60_000,
  repairRate: 0.1,
  spendFraction: 0.7,
  rateLimitShare: 0.2,
  abuseMultiple: 5,
  minSample: 10,
};

export interface Signal {
  name: string;
  value: number | null;
  threshold: number;
  sample: number;
  window: string;
  alert: boolean;
  detail?: string;
}

export interface OpsInput {
  rows: BriefRecord[];
  now: number;
  spendTodayUsd: number;
  spendCapUsd: number;
  thresholds?: OpsThresholds;
}

const finished = (r: BriefRecord) => ["succeeded", "partial", "failed"].includes(r.status);
const analyzedSeconds = (r: BriefRecord) =>
  r.range ? r.range.end_seconds - r.range.start_seconds : (r.video?.durationSeconds ?? null);

function p95(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
}

export function computeSignals(input: OpsInput): Signal[] {
  const t = input.thresholds ?? PRD_THRESHOLDS;
  const { rows, now } = input;
  const since = (ms: number) => rows.filter((r) => r.updatedAt.getTime() >= now - ms);
  const signals: Signal[] = [];

  // Job failure rate, excluding user-caused errors (15 minutes).
  {
    const jobs = since(15 * MIN).filter(finished);
    const failedOurs = jobs.filter((r) => {
      const code =
        r.status === "failed"
          ? r.error?.code
          : r.status === "partial"
            ? r.meta.lastErrorCode
            : undefined;
      return code !== undefined && !USER_CAUSED.has(code);
    });
    const considered = jobs.filter(
      (r) => !(r.status === "failed" && r.error && USER_CAUSED.has(r.error.code)),
    );
    const rate = considered.length ? failedOurs.length / considered.length : null;
    signals.push({
      name: "job_failure_rate",
      value: rate,
      threshold: t.failureRate,
      sample: considered.length,
      window: "15m",
      alert: rate !== null && considered.length >= t.minSample && rate > t.failureRate,
    });
  }

  // p95 latency for videos up to 3 minutes, real runs only (30 minutes).
  {
    const runs = since(30 * MIN).filter(
      (r) => r.status === "succeeded" && !r.meta.cached && (analyzedSeconds(r) ?? Infinity) <= 180,
    );
    const v = p95(runs.map((r) => r.meta.timingsMs.total ?? 0));
    signals.push({
      name: "p95_latency_ms_up_to_3min",
      value: v,
      threshold: t.p95LatencyMs,
      sample: runs.length,
      window: "30m",
      alert: v !== null && runs.length >= Math.ceil(t.minSample / 2) && v > t.p95LatencyMs,
    });
  }

  // Repair-call rate (1 hour): prompt or model drift.
  {
    const runs = since(HOUR).filter((r) => finished(r) && !r.meta.pass1Cached);
    const repaired = runs.filter((r) => r.meta.repairUsed).length;
    const rate = runs.length ? repaired / runs.length : null;
    signals.push({
      name: "repair_rate",
      value: rate,
      threshold: t.repairRate,
      sample: runs.length,
      window: "1h",
      alert: rate !== null && runs.length >= t.minSample && rate > t.repairRate,
    });
  }

  // Gemini quota pressure (1 hour). The PRD asks for "quota used over 80%"; the Gemini API
  // doesn't report quota use, so this tracks the share of jobs that hit a 429 instead.
  {
    const runs = since(HOUR).filter(finished);
    const limited = runs.filter((r) =>
      (r.meta.upstreamFailures ?? []).some((f) => f.status === 429),
    ).length;
    const share = runs.length ? limited / runs.length : null;
    signals.push({
      name: "gemini_rate_limit_share",
      value: share,
      threshold: t.rateLimitShare,
      sample: runs.length,
      window: "1h",
      alert: share !== null && runs.length >= t.minSample && share > t.rateLimitShare,
      detail: "proxy for quota use; check the quota page in Google Cloud",
    });
  }

  // Daily spend.
  {
    const fraction = input.spendCapUsd > 0 ? input.spendTodayUsd / input.spendCapUsd : null;
    signals.push({
      name: "daily_spend_fraction",
      value: fraction,
      threshold: t.spendFraction,
      sample: 1,
      window: "today",
      alert: fraction !== null && fraction > t.spendFraction,
      detail: `$${input.spendTodayUsd.toFixed(2)} of $${input.spendCapUsd}`,
    });
  }

  // CONTENT_BLOCKED or RECITATION doubling week over week.
  {
    const count = (from: number, to: number) =>
      rows
        .filter((r) => r.createdAt.getTime() >= from && r.createdAt.getTime() < to)
        .reduce(
          (n, r) =>
            n +
            (r.error?.code === "CONTENT_BLOCKED" ? 1 : 0) +
            (r.meta.upstreamFailures ?? []).filter((f) => f.finishReason === "RECITATION").length,
          0,
        );
    const thisWeek = count(now - 7 * DAY, now + 1);
    const lastWeek = count(now - 14 * DAY, now - 7 * DAY);
    const ratio = lastWeek ? thisWeek / lastWeek : thisWeek ? Infinity : null;
    signals.push({
      name: "blocked_or_recitation_wow",
      value: ratio === Infinity ? null : ratio,
      threshold: 2,
      sample: thisWeek,
      window: "7d vs prior 7d",
      alert: thisWeek >= 5 && (lastWeek === 0 || thisWeek >= 2 * lastWeek),
      detail: `${thisWeek} this week, ${lastWeek} last week`,
    });
  }

  // Abuse: an account over 5x its typical daily volume (PRD security).
  {
    const perUser = (from: number, to: number) => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const at = r.createdAt.getTime();
        if (at >= from && at < to) m.set(r.userId, (m.get(r.userId) ?? 0) + 1);
      }
      return m;
    };
    const today = perUser(now - DAY, now + 1);
    const week = perUser(now - 8 * DAY, now - DAY);
    const dailyAverages = [...week.values()].map((n) => n / 7).sort((a, b) => a - b);
    const typical = Math.max(5, dailyAverages[Math.floor(dailyAverages.length / 2)] ?? 0);
    const offenders = [...today.entries()].filter(
      ([, n]) => n >= 20 && n > t.abuseMultiple * typical,
    );
    signals.push({
      name: "abuse_accounts",
      value: offenders.length,
      threshold: t.abuseMultiple,
      sample: today.size,
      window: "24h vs typical",
      alert: offenders.length > 0,
      detail:
        offenders
          .map(([u, n]) => `${u}: ${n} today (typical ${typical.toFixed(1)}/day)`)
          .join("; ") || undefined,
    });
  }

  return signals;
}
