/**
 * Builds the analyzer and pipeline settings from env. Shared by the worker and by the API's
 * synchronous fallback (PRD "Job store down"), so both run the same code.
 */
import { loadManifest, loadPricing, type Env, type ModelNames } from "@match-cut/core";
import {
  MemoryBriefEvents,
  MemoryBriefStore,
  type BriefRecord,
  type KV,
  type RateLimiter,
  type SpendTracker,
} from "@match-cut/infra";
import {
  GeminiAnalyzer,
  MockAnalyzer,
  withFallback,
  type VideoAnalyzer,
  type VideoLookup,
} from "@match-cut/providers";
import { runJob, type PipelineDeps } from "./pipeline.js";

export function buildAnalyzer(env: Env, models: ModelNames): VideoAnalyzer {
  if (env.PROVIDER === "mock") {
    // Simulated latency so the progress view is visible in dev.
    return new MockAnalyzer({
      watchDelayMs: env.MOCK_WATCH_DELAY_MS,
      writeDelayMs: env.MOCK_WRITE_DELAY_MS,
      slowDelayMs: 30000,
    });
  }
  return withFallback(new GeminiAnalyzer({ apiKey: env.GEMINI_API_KEY! }), {
    fallbacks: models.fallbacks,
    backoffMs: env.GEMINI_RETRY_BACKOFF_MS.split(",").map(Number),
    retrySameModel: env.GEMINI_RETRY_SAME_MODEL,
    maxAttempts: 1 + env.GEMINI_RETRY_SAME_MODEL + models.fallbacks.length,
    // An overloaded model (503) rarely recovers within seconds: go straight to the next one,
    // keep 40 s of the job for a fallback, and don't start an attempt with under 8 s left.
    skipSameModelOnOverload: true,
    fallbackReserveMs: 40_000,
    minAttemptMs: 8_000,
    onAttempt: ({ model, attempt, error, hint }) => {
      if (error)
        console.warn(
          `[gemini] ${model} attempt ${attempt} failed: ${error.error.code}${hint ? ` (hint ${hint})` : ""}`,
        );
    },
  });
}

export function pipelineSettings(
  env: Env,
): Pick<PipelineDeps, "budget" | "queueMaxWaitMs" | "region" | "pricing" | "manifest"> {
  return {
    budget: {
      maxFailedAttempts: env.JOB_MAX_FAILED_ATTEMPTS,
      timeoutMs: env.JOB_TIMEOUT_SECONDS * 1000,
    },
    queueMaxWaitMs: env.QUEUE_MAX_WAIT_SECONDS * 1000,
    region: env.YOUTUBE_REGION,
    pricing: loadPricing(),
    manifest: loadManifest(),
  };
}

/** Runs one brief to completion in memory and returns it. For the job-store-down fallback. */
export function makeSyncRunner(opts: {
  env: Env;
  models: ModelNames;
  analyzer: VideoAnalyzer;
  kv: KV;
  lookup: VideoLookup;
  spend?: SpendTracker;
  limiter?: RateLimiter;
  log?: PipelineDeps["log"];
}) {
  const settings = pipelineSettings(opts.env);
  return async (record: BriefRecord): Promise<BriefRecord> => {
    const store = new MemoryBriefStore();
    await store.create(record);
    await runJob(
      { briefId: record.id, kind: "analyze" },
      {
        ...settings,
        store,
        kv: opts.kv,
        events: new MemoryBriefEvents(),
        analyzer: opts.analyzer,
        models: opts.models,
        lookup: opts.lookup,
        spend: opts.spend,
        limiter: opts.limiter,
        log: opts.log,
      },
    );
    return (await store.get(record.id))!;
  };
}
