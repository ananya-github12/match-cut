/**
 * The brief pipeline: pass 1 (watch), pass 2 (write prompt), validate, save.
 * PRD: "Backend: architecture and request flow" and "Backend: error handling and failure modes".
 * The API runs the precheck before queuing. Retries, finish-reason retries and the fallback chain
 * wrap the analyzer (withFallback) and spend this job's budget.
 */
import {
  apiError,
  breakdownWarnings,
  briefKeys,
  canonicalYouTubeUrl,
  classifyVideoState,
  costUsd,
  isTerminal,
  MatchCutError,
  PASS1_TTL_SECONDS,
  PASS1_PROMPT_VERSION,
  PASS2_PROMPT_VERSION,
  PASS2_TTL_SECONDS,
  SCHEMA_VERSION,
  pass1OutputSchema,
  pass2OutputSchema,
  warning,
  type ApiError,
  type BriefStage,
  type CapabilityManifest,
  type ModelNames,
  type Pass1Output,
  type Pass2Output,
  type Pricing,
} from "@match-cut/core";
import type {
  BriefEvents,
  BriefMeta,
  BriefRecord,
  BriefStore,
  JobData,
  KV,
  RateLimiter,
  SpendTracker,
} from "@match-cut/infra";
import {
  JobBudget,
  type UpstreamFailure,
  type VideoAnalyzer,
  type VideoLookup,
} from "@match-cut/providers";
import { watchAndValidate } from "./pass1.js";
import { writeAndValidate } from "./pass2.js";

export interface PipelineDeps {
  store: BriefStore;
  kv: KV;
  events: BriefEvents;
  analyzer: VideoAnalyzer;
  manifest: CapabilityManifest;
  models: ModelNames;
  /** PRD job budget. Defaults: 4 failed upstream attempts, 240 s. */
  budget?: { maxFailedAttempts: number; timeoutMs: number };
  /** PRD: a job waiting longer than this fails with CAPACITY_EXHAUSTED. Default 120 s. */
  queueMaxWaitMs?: number;
  /** Uncached video lookup, to re-run the precheck when Gemini can't access the video. */
  lookup?: VideoLookup;
  region?: string;
  pricing?: Pricing;
  spend?: SpendTracker;
  limiter?: RateLimiter;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

class Cancelled extends Error {}

/** Errors that are ours, not the user's: PRD "failed jobs are not billed to user quotas". */
/** Job time pass 1 leaves unused for pass 2 (one 20 s attempt plus a quick fallback). */
export const PASS2_RESERVE_MS = 25_000;

const UPSTREAM_CODES = new Set([
  "UPSTREAM_ERROR",
  "UPSTREAM_TIMEOUT",
  "CAPACITY_EXHAUSTED",
  "INVALID_MODEL_OUTPUT",
  "INTERNAL",
]);

export async function runJob(job: JobData, deps: PipelineDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const { store, kv, events, analyzer } = deps;

  const initial = await store.get(job.briefId);
  if (!initial || initial.status === "cancelled" || isTerminal(initial.status)) return;
  let brief: BriefRecord = initial;
  const keys = briefKeys(brief, deps.models, deps.manifest.manifest_version);
  const who = { userId: brief.userId, orgId: brief.orgId };
  // A job BullMQ restarted after a worker crash resumes from the last finished pass.
  const resumed = initial.status === "processing";

  const startedAt = now();
  const timings: Record<string, number> = { ...brief.meta.timingsMs };
  const tokens: Record<string, number> = { ...brief.meta.tokens };
  if (job.kind === "analyze" && !resumed)
    timings.queue_wait = startedAt - brief.createdAt.getTime();
  const budget = new JobBudget({
    maxFailedAttempts: deps.budget?.maxFailedAttempts ?? 4,
    timeoutMs: deps.budget?.timeoutMs ?? 240_000,
    now,
  });
  let cost = brief.meta.costUsd ?? 0;
  const charge = async (model: string, t: { input: number; output: number }) => {
    if (!deps.pricing) return;
    const usd = costUsd(deps.pricing, model, t);
    cost += usd;
    await deps.spend?.add(usd);
  };

  // Abort the in-flight model call as soon as the brief is cancelled.
  const controller = new AbortController();
  const unsubscribe = await events.subscribe(brief.id, () => {
    void store.get(brief.id).then((b) => {
      if (!b || b.status === "cancelled") controller.abort(new Cancelled());
    });
  });

  const save = async (patch: Partial<BriefRecord>) => {
    const fresh = await store.get(brief.id);
    if (!fresh || fresh.status === "cancelled") throw new Cancelled();
    const updated = await store.update(brief.id, patch);
    if (!updated) throw new Cancelled();
    brief = updated;
    await events.publish(brief.id);
  };
  const stage = (s: BriefStage) => save({ status: "processing", stage: s });
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = now();
    try {
      return await fn();
    } finally {
      timings[name] = (timings[name] ?? 0) + (now() - t);
    }
  };

  let pass1Cached = brief.meta.pass1Cached ?? false;
  let repairUsed = brief.meta.repairUsed ?? false;
  let fallbackUsed = brief.meta.fallbackUsed ?? false;
  let pass1Model =
    brief.meta.model ?? (brief.detail === "deep" ? deps.models.deep : deps.models.standard);
  let pass2Model = deps.models.pass2;
  let pass2Cached = false;
  let outcome = "succeeded";
  let errorCode: string | undefined;
  const upstreamFailures: UpstreamFailure[] = [...(brief.meta.upstreamFailures ?? [])];

  try {
    if (
      job.kind === "analyze" &&
      !resumed &&
      timings.queue_wait! > (deps.queueMaxWaitMs ?? 120_000)
    ) {
      throw new MatchCutError(
        "CAPACITY_EXHAUSTED",
        {},
        { reason: "queue_wait", waitedMs: timings.queue_wait },
      );
    }

    // ---------- Pass 1: watch (skipped when the brief already has a breakdown) ----------
    if (!brief.breakdown) {
      const cached = brief.forceRefresh ? null : await kv.get(keys.pass1);
      let out: Pass1Output;
      if (cached) {
        out = pass1OutputSchema.parse(JSON.parse(cached));
        pass1Cached = true;
      } else {
        await stage("watching");
        const model = brief.detail === "deep" ? deps.models.deep : deps.models.standard;
        const analyzedSeconds = brief.range
          ? brief.range.end_seconds - brief.range.start_seconds
          : (brief.video?.durationSeconds ?? null);
        const run = await timed("watching", () =>
          watchAndValidate(
            analyzer,
            {
              videoId: brief.videoId,
              canonicalUrl: canonicalYouTubeUrl(brief.videoId),
              range: brief.range,
              detail: brief.detail,
              model,
              durationSeconds: brief.video?.durationSeconds ?? null,
            },
            analyzedSeconds,
            controller.signal,
            // Leave room in the job budget for pass 2, so a slow pass 1 doesn't starve it.
            { budget, reserveAfterMs: PASS2_RESERVE_MS },
          ),
        );
        out = run.output;
        tokens.pass1_input = run.tokens.input;
        tokens.pass1_output = run.tokens.output;
        repairUsed = run.repairUsed;
        pass1Model = run.model;
        fallbackUsed = run.fallbackUsed;
        await charge(run.model, run.tokens);
        upstreamFailures.push(...run.upstreamFailures);
        if (run.repairUsed) log("pass 1 repaired", { briefId: brief.id, problems: run.problems });
        // Only cache results from the requested model, so a fallback result isn't served for
        // 30 days to requests that should get the standard model.
        if (!run.fallbackUsed) await kv.set(keys.pass1, JSON.stringify(out), PASS1_TTL_SECONDS);
      }
      const { spoken_lines_internal, ...breakdown } = out;
      const known = new Set(brief.warnings.map((w) => w.code));
      const extra = breakdownWarnings(out)
        .filter((c) => !known.has(c))
        .map((c) => warning(c));
      await save({
        breakdown,
        spokenLines: spoken_lines_internal,
        warnings: [...brief.warnings, ...extra],
        meta: {
          ...brief.meta,
          model: pass1Model,
          pass1Cached,
          repairUsed,
          fallbackUsed,
          tokens,
          timingsMs: timings,
          costUsd: cost,
          upstreamFailures,
        },
      });
    }

    // ---------- Pass 2: write the prompt ----------
    const cached2 = brief.forceRefresh && job.kind === "analyze" ? null : await kv.get(keys.pass2);
    let prompt: Pass2Output;
    let shotListDropped = false;
    if (cached2) {
      prompt = pass2OutputSchema.parse(JSON.parse(cached2));
      pass2Cached = true;
    } else {
      await stage("writing_prompt");
      const t0 = now();
      let tValidate = 0;
      const run = await writeAndValidate(
        analyzer,
        {
          breakdown: brief.breakdown!,
          goal: brief.goal,
          format: brief.targetFormat,
          lengthSeconds: brief.targetLengthSeconds,
          language: brief.outputLanguage,
          manifest: deps.manifest,
          model: deps.models.pass2,
        },
        brief.spokenLines ?? [],
        controller.signal,
        async () => {
          tValidate = now();
          timings.writing_prompt = (timings.writing_prompt ?? 0) + (tValidate - t0);
          await stage("validating");
        },
        { budget },
      );
      timings.validating = (timings.validating ?? 0) + (now() - tValidate);
      prompt = run.output;
      pass2Model = run.model;
      tokens.pass2_input = run.tokens.input;
      tokens.pass2_output = run.tokens.output;
      await charge(run.model, run.tokens);
      upstreamFailures.push(...run.upstreamFailures);
      if (run.repairUsed) log("pass 2 repaired", { briefId: brief.id, problems: run.problems });
      shotListDropped = run.shotListDropped;
      if (shotListDropped) log("shot list dropped", { briefId: brief.id, problems: run.problems });
      // Not cached with a dropped shot list, so "regenerate to try again" really tries again.
      if (!run.fallbackUsed && !shotListDropped)
        await kv.set(keys.pass2, JSON.stringify(prompt), PASS2_TTL_SECONDS);
    }

    timings.total = (timings.total ?? 0) + (now() - startedAt);
    // The shot-list warning describes this prompt only; a regenerate clears or re-adds it.
    const warnings = [
      ...brief.warnings.filter((w) => w.code !== "SHOT_LIST_UNAVAILABLE"),
      ...(shotListDropped ? [warning("SHOT_LIST_UNAVAILABLE")] : []),
    ];
    await save({
      status: "succeeded",
      stage: null,
      prompt,
      warnings,
      error: null,
      meta: {
        ...brief.meta,
        pass2Model,
        cached: pass1Cached && pass2Cached,
        pass2Cached,
        tokens,
        timingsMs: timings,
        costUsd: cost,
        upstreamFailures,
        failure: undefined,
      },
    });
  } catch (caught) {
    if (caught instanceof Cancelled || controller.signal.aborted) {
      outcome = "cancelled";
      return;
    }
    let err = caught;
    if (!(err instanceof MatchCutError)) {
      log("unexpected pipeline error", { briefId: brief.id, err: String(err) });
    }
    const latest = await store.get(brief.id);
    if (!latest || latest.status === "cancelled") {
      outcome = "cancelled";
      return;
    }
    // PRD: Gemini can't access the video -> no retry; re-run the precheck to classify.
    if (
      err instanceof MatchCutError &&
      err.detail?.clientError &&
      !latest.breakdown &&
      deps.lookup
    ) {
      err = await reclassify(err, latest.videoId, deps);
    }
    const error: ApiError = err instanceof MatchCutError ? err.error : apiError("INTERNAL");
    const detail = (err instanceof MatchCutError ? err.detail : undefined) ?? {};
    errorCode = error.code;
    timings.total = (timings.total ?? 0) + (now() - startedAt);
    // PRD: pass 1 done but pass 2 failed -> partial, with the breakdown and no prompt.
    const partial = latest.breakdown !== null;
    outcome = partial ? "partial" : "failed";
    if (Array.isArray(detail.failures))
      upstreamFailures.push(...(detail.failures as UpstreamFailure[]));
    const failure: NonNullable<BriefMeta["failure"]> = {
      code: error.code,
      ...(typeof detail.status === "number" ? { upstreamStatus: detail.status } : {}),
      ...(typeof detail.finishReason === "string" ? { finishReason: detail.finishReason } : {}),
      attempts: typeof detail.attempts === "number" ? detail.attempts : budget.failures,
      ...(Array.isArray(detail.models) ? { models: detail.models as string[] } : {}),
    };
    await store.update(brief.id, {
      status: partial ? "partial" : "failed",
      stage: null,
      prompt: partial ? null : latest.prompt,
      error: partial ? null : error,
      meta: {
        ...latest.meta,
        tokens,
        timingsMs: timings,
        costUsd: cost,
        upstreamFailures,
        lastErrorCode: error.code,
        failure,
      },
    });
    await events.publish(brief.id);
    if (detail.billing) log("ALERT: Gemini billing problem; every model is refusing requests", {});
    // Not the user's fault: give the rate-limit slot back.
    if (UPSTREAM_CODES.has(error.code) && deps.limiter) {
      await deps.limiter.refund(
        job.kind,
        who,
        job.kind === "analyze" ? brief.createdAt : initial.updatedAt,
      );
    }
  } finally {
    await kv.del(keys.inflight);
    await unsubscribe();
    // One line per job for dashboards. PRD: goal text is never logged.
    log("job finished", {
      briefId: brief.id,
      userId: brief.userId,
      orgId: brief.orgId,
      videoId: brief.videoId,
      kind: job.kind,
      outcome,
      errorCode,
      durationSeconds: brief.video?.durationSeconds ?? null,
      range: brief.range,
      detail: brief.detail,
      model: pass1Model,
      pass2Model,
      cache: { pass1: pass1Cached, pass2: pass2Cached },
      repairUsed,
      fallbackUsed,
      failedAttempts: budget.failures,
      upstreamFailures,
      finishReasons: [...new Set(upstreamFailures.map((f) => f.finishReason).filter(Boolean))],
      versions: {
        pass1Prompt: PASS1_PROMPT_VERSION,
        pass2Prompt: PASS2_PROMPT_VERSION,
        schema: SCHEMA_VERSION,
        manifest: deps.manifest.manifest_version,
      },
      timingsMs: timings,
      tokens,
      costUsd: Number(cost.toFixed(6)),
      warnings: brief.warnings.map((w) => w.code),
      resumed,
    });
  }
}

/** Maps "Gemini can't access the video" to the video's real state, via an uncached lookup. */
async function reclassify(
  err: MatchCutError,
  videoId: string,
  deps: PipelineDeps,
): Promise<MatchCutError> {
  try {
    const r = await deps.lookup!.lookup(videoId);
    if (r.status === "not_found") return new MatchCutError("VIDEO_NOT_FOUND", {}, err.detail);
    if (r.status === "found") {
      const state = classifyVideoState(r.video, deps.region ?? "US");
      if (state.error) return new MatchCutError(state.error, {}, err.detail);
    }
  } catch {
    // keep the original error
  }
  return err;
}
