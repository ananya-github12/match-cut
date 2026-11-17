/**
 * Retries, finish-reason retries and the model fallback chain, within the job budget.
 * PRD: "Backend: error handling and failure modes".
 *
 *   429 / 500 / 503 / empty response  retry the requested model once, then each fallback model
 *   RECITATION                        retry once on the same model with a no-quoting reminder
 *   MAX_TOKENS                        retry once on the same model with a higher cap, "be concise"
 *   timeout                           retry only if at least 30 s of the job budget remain
 *   blocked, client errors, billing   no retry
 * Every failed attempt spends the job budget; when it runs out the last error is returned.
 */
import { MatchCutError } from "@match-cut/core";
import type {
  CallContext,
  ModelResult,
  UpstreamFailure,
  RepairInput,
  RetryHint,
  VideoAnalyzer,
  WatchInput,
  WritePromptInput,
} from "./types.js";

export interface FallbackOptions {
  /** Models tried, in order, after the requested one. */
  fallbacks: string[];
  /** Attempts planned per call. Default 4: requested model twice, then two fallbacks. */
  maxAttempts?: number;
  /** Extra attempts on the requested model before moving to a fallback. Default 1. */
  retrySameModel?: number;
  /** Wait before attempt n+1 (PRD: 1 s, then 3 s); the last value repeats. ±25% jitter. */
  backoffMs?: number[];
  /** PRD: no timeout retry when less than this remains. */
  minRemainingForTimeoutRetryMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onAttempt?: (info: {
    model: string;
    attempt: number;
    error?: MatchCutError;
    hint?: RetryHint;
  }) => void;
}

/** Failures worth another attempt on the next model in the plan. */
export function isRetryable(err: unknown): err is MatchCutError {
  if (!(err instanceof MatchCutError)) return false;
  const d = err.detail ?? {};
  if (d.billing) return false; // same billing account for every model
  if (err.error.code === "CAPACITY_EXHAUSTED") return true;
  if (err.error.code !== "UPSTREAM_ERROR") return false;
  if (d.clientError) return false; // 4xx about the video: the pipeline re-runs the precheck
  return true;
}

const HINTS: Record<string, RetryHint> = { RECITATION: "no_quoting", MAX_TOKENS: "be_concise" };

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}

/** The ordered list of models a call will try. */
export function attemptPlan(requested: string, opts: FallbackOptions): string[] {
  const same = Array.from({ length: 1 + (opts.retrySameModel ?? 1) }, () => requested);
  const rest = opts.fallbacks.filter((m) => m !== requested);
  return [...same, ...rest].slice(0, opts.maxAttempts ?? 4);
}

export function withFallback(inner: VideoAnalyzer, opts: FallbackOptions): VideoAnalyzer {
  const sleep = opts.sleep ?? defaultSleep;
  const backoff = opts.backoffMs ?? [1000, 3000];
  const minForTimeoutRetry = opts.minRemainingForTimeoutRetryMs ?? 30_000;

  async function run<I extends { model: string }>(
    input: I,
    call: (i: I, signal?: AbortSignal, ctx?: CallContext) => Promise<ModelResult>,
    signal?: AbortSignal,
    ctx: CallContext = {},
  ): Promise<ModelResult> {
    const plan = attemptPlan(input.model, opts);
    const budget = ctx.budget;
    let hint = ctx.hint;
    let hintUsed = false;
    let lastError: MatchCutError | undefined;
    let attempts = 0;
    const models = new Set<string>();
    /** Every failed attempt, for logs and ops signals (PRD: finish reasons per job). */
    const failures: UpstreamFailure[] = [];
    const giveUp = (err: MatchCutError) =>
      new MatchCutError(
        err.error.code,
        {},
        { ...(err.detail ?? {}), attempts, models: [...models], failures },
      );

    for (let i = 0; i < plan.length;) {
      const model = plan[i]!;
      if (attempts > 0) {
        const base = backoff[Math.min(attempts - 1, backoff.length - 1)]!;
        const wait = Math.round(base * (0.75 + Math.random() * 0.5));
        await sleep(budget ? Math.min(wait, budget.remainingMs()) : wait, signal);
      }
      const remaining = budget?.remainingMs();
      if (remaining !== undefined && remaining <= 0) {
        throw giveUp(new MatchCutError("UPSTREAM_TIMEOUT", {}, { reason: "job_budget" }));
      }
      attempts++;
      models.add(model);
      // Enforce the time limit here too, not only in the provider: a call that never answers
      // is cancelled and counts as a timeout.
      const timeoutMs = Math.min(ctx.timeoutMs ?? Infinity, remaining ?? Infinity);
      const attempt = new AbortController();
      const onOuterAbort = () => attempt.abort(signal?.reason);
      signal?.addEventListener("abort", onOuterAbort);
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(
            () =>
              attempt.abort(
                new MatchCutError("UPSTREAM_TIMEOUT", {}, { reason: "attempt_timeout", timeoutMs }),
              ),
            timeoutMs,
          )
        : undefined;
      try {
        const res = await call({ ...input, model }, attempt.signal, { ...ctx, hint, timeoutMs });
        opts.onAttempt?.({ model, attempt: attempts, hint });
        return {
          ...res,
          model,
          attempts,
          fallbackUsed: model !== input.model,
          upstreamFailures: failures,
        };
      } catch (caught) {
        if (signal?.aborted) throw caught;
        const err =
          attempt.signal.aborted && attempt.signal.reason instanceof MatchCutError
            ? attempt.signal.reason
            : caught;
        if (!(err instanceof MatchCutError)) throw err;
        opts.onAttempt?.({ model, attempt: attempts, error: err, hint });
        failures.push({
          model,
          code: err.error.code,
          ...(typeof err.detail?.status === "number" ? { status: err.detail.status } : {}),
          ...(typeof err.detail?.finishReason === "string"
            ? { finishReason: err.detail.finishReason }
            : {}),
        });
        lastError = err;
        const finish = err.detail?.finishReason as string | undefined;
        const nextHint = finish ? HINTS[finish] : undefined;
        if (nextHint && !hintUsed) {
          // Same model again, once, with the stricter instruction.
          hintUsed = true;
          hint = nextHint;
          if (budget && !budget.fail()) throw giveUp(err);
          continue;
        }
        const timeoutRetry =
          err.error.code === "UPSTREAM_TIMEOUT" &&
          budget !== undefined &&
          budget.remainingMs() >= minForTimeoutRetry;
        if (!timeoutRetry && !isRetryable(err)) throw giveUp(err);
        if (budget && !budget.fail()) throw giveUp(err);
        i++;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    }
    throw giveUp(lastError ?? new MatchCutError("UPSTREAM_ERROR"));
  }

  return {
    watch: (input: WatchInput, signal?: AbortSignal, ctx?: CallContext) =>
      run(input, (i, s, c) => inner.watch(i, s, c), signal, ctx),
    repair: (input: RepairInput, signal?: AbortSignal, ctx?: CallContext) =>
      run(input, (i, s, c) => inner.repair(i, s, c), signal, ctx),
    writePrompt: (input: WritePromptInput, signal?: AbortSignal, ctx?: CallContext) =>
      run(input, (i, s, c) => inner.writePrompt(i, s, c), signal, ctx),
  };
}
