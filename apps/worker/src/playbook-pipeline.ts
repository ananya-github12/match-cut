/**
 * The playbook pipeline. PRD-playbooks.md, Feature 3 > Request flow: resolve the channel, fetch
 * recent uploads, score and pick (code), watch each pick with pass 1 (the brief cache is shared;
 * at most 3 at a time), extract features (text), compare (code), write the playbook (text),
 * validate, save. Numbers come from code; every playbook passes the faithfulness check or fails.
 *
 * Failures: a problem with one video (bad output, a video Gemini can't access) leaves that video
 * out. A passing problem (overload, timeout) fails the playbook as retryable at once and stops
 * the other calls: a retry is cheap, since finished videos come back from the pass 1 and feature
 * caches. That's also how a job restarted after a worker crash resumes. Every write is
 * conditional on the playbook still running, so a cancel always wins.
 */
import {
  apiError,
  canonicalYouTubeUrl,
  checkPlaybook,
  COMPARISON_VERSION,
  compareFeatures,
  costUsd,
  factsProblems,
  faithfulnessProblems,
  featureRow,
  featuresCacheKey,
  FEATURES_TTL_SECONDS,
  FEATURES_VERSION,
  isTerminal,
  MatchCutError,
  MIN_OUTLIERS,
  MIN_TYPICAL,
  needsPlaybookWriting,
  pass1CacheKey,
  pass1OutputSchema,
  PASS1_PROMPT_VERSION,
  PASS1_TTL_SECONDS,
  playbookCacheKey,
  PLAYBOOK_TTL_SECONDS,
  PLAYBOOK_VERSION,
  playbookWarning,
  SCHEMA_VERSION,
  scoreChannel,
  SMALL_SAMPLE_PICKS,
  type ApiError,
  type CapabilityManifest,
  type ComparedVideo,
  type FeatureRow,
  type ModelNames,
  type Pass1Output,
  type PlaybookContent,
  type PlaybookFacts,
  type PlaybookStage,
  type PlaybookWarning,
  type Pricing,
  type ScoredVideo,
} from "@match-cut/core";
import type {
  BriefEvents,
  KV,
  PlaybookComparison,
  PlaybookJobData,
  PlaybookMeta,
  PlaybookPatch,
  PlaybookRecord,
  PlaybookStore,
  PlaybookVideo,
  SpendTracker,
} from "@match-cut/infra";
import {
  JobBudget,
  type ChannelLookup,
  type UnavailableReason,
  type UpstreamFailure,
  type VideoAnalyzer,
} from "@match-cut/providers";
import { watchAndValidate } from "./pass1.js";
import {
  extractAndGround,
  mapLimit,
  readCachedFeatures,
  writeAndCheck,
  type StepUsage,
} from "./playbook-steps.js";

export interface PlaybookPipelineDeps {
  store: PlaybookStore;
  kv: KV;
  /** Stage updates for SSE (keyed by playbook ID). */
  events: BriefEvents;
  channels: ChannelLookup;
  analyzer: VideoAnalyzer;
  manifest: CapabilityManifest;
  models: ModelNames;
  /** Budget per model step (each watch, each extraction, the writing), as a brief's job budget. */
  budget?: { maxFailedAttempts: number; timeoutMs: number };
  /** The whole playbook. Default 600 s. Step budgets never run past it. */
  timeoutMs?: number;
  /** PRD: at most 3 concurrent pass 1 calls per playbook. */
  watchConcurrency?: number;
  /** PRD: a job waiting longer than this fails with CAPACITY_EXHAUSTED. Default 120 s. */
  queueMaxWaitMs?: number;
  pricing?: Pricing;
  spend?: SpendTracker;
  /**
   * PRD: failed jobs aren't billed to user quotas. Called when a playbook fails for a reason
   * that isn't the user's (the API wires it to the rate limiter).
   */
  refund?: (pb: PlaybookRecord) => Promise<void>;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Abort reasons. */
class Cancelled extends Error {}
class TimedOut extends Error {}
class StepFailed extends Error {
  constructor(readonly cause: MatchCutError) {
    super(cause.message);
  }
}
class JobEnded extends Error {}

const RUNNING = ["queued", "processing"] as const;

/** Failures that aren't the user's: their rate-limit slot is given back (as v1). */
const NOT_USERS_FAULT = new Set([
  "UPSTREAM_ERROR",
  "UPSTREAM_TIMEOUT",
  "CAPACITY_EXHAUSTED",
  "INVALID_MODEL_OUTPUT",
  "INTERNAL",
]);

/** Problems with one video, not with the service: that video is left out. */
const PER_VIDEO_CODES = new Set([
  "INVALID_MODEL_OUTPUT",
  "CONTENT_BLOCKED",
  "NO_ANALYZABLE_CONTENT",
  "VIDEO_NOT_FOUND",
  "VIDEO_NOT_PUBLIC",
  "VIDEO_RESTRICTED",
  "LIVE_NOT_SUPPORTED",
  "VIDEO_TOO_LONG",
]);

export function isPerVideoFailure(e: unknown): boolean {
  return (
    e instanceof MatchCutError &&
    // A 4xx from Gemini (other than quota) means it can't access this video.
    (PER_VIDEO_CODES.has(e.error.code) || e.detail?.clientError === true)
  );
}

const asMatchCut = (e: unknown) =>
  e instanceof MatchCutError ? e : new MatchCutError("INTERNAL", {}, { err: String(e) });

/** What the 24-hour playbook cache holds: everything but the request, owner and meta. */
type CachedPlaybook = Pick<
  PlaybookRecord,
  | "channel"
  | "window"
  | "baseline"
  | "videos"
  | "comparison"
  | "content"
  | "spokenLines"
  | "warnings"
>;

interface Watched {
  video: ScoredVideo;
  group: "outlier" | "typical";
  output: Pass1Output;
  pass1Key: string;
}

function youtubeUnavailable(reason: UnavailableReason): MatchCutError {
  // PRD: YouTube Data API quota exhaustion maps to CAPACITY_EXHAUSTED.
  return reason === "quota"
    ? new MatchCutError("CAPACITY_EXHAUSTED", {}, { source: "youtube", reason })
    : new MatchCutError("UPSTREAM_ERROR", {}, { source: "youtube", reason });
}

function toPlaybookVideo(v: ScoredVideo): PlaybookVideo {
  return {
    id: v.id,
    title: v.title,
    publishedAt: v.publishedAt,
    durationSeconds: v.durationSeconds,
    views: v.views,
    likes: v.likes,
    comments: v.comments,
    outlierScore: v.outlierScore,
    engagementRate: v.engagementRate,
    group: v.group,
    compared: false,
    // Compared videos' breakdowns live in the shared pass 1 cache, not in a brief (M10.6).
    briefId: null,
  };
}

function addWarnings(into: PlaybookWarning[], more: PlaybookWarning[]): PlaybookWarning[] {
  const out = [...into];
  for (const w of more) if (!out.some((x) => x.code === w.code)) out.push(w);
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A cached playbook, checked field by field before it's served as someone's result. */
function readCachedPlaybook(raw: string | null): CachedPlaybook | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const content = p.content as Record<string, unknown> | undefined;
    const comparison = p.comparison as Record<string, unknown> | undefined;
    const ok =
      isObj(p.channel) &&
      typeof p.channel.id === "string" &&
      isObj(p.window) &&
      isObj(p.baseline) &&
      Array.isArray(p.videos) &&
      isObj(comparison) &&
      Array.isArray(comparison.rules) &&
      Array.isArray(comparison.table) &&
      isObj(content) &&
      Array.isArray(content.rules) &&
      typeof content.house_style === "string" &&
      Array.isArray(content.not_explained) &&
      Array.isArray(p.spokenLines) &&
      Array.isArray(p.warnings);
    return ok ? (p as unknown as CachedPlaybook) : null;
  } catch {
    return null;
  }
}

export async function runPlaybookJob(
  job: PlaybookJobData,
  deps: PlaybookPipelineDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const { store, kv, events, analyzer } = deps;

  const initial = await store.get(job.playbookId);
  if (!initial || isTerminal(initial.status)) return;
  let pb: PlaybookRecord = initial;
  const resumed = initial.status === "processing";
  const settings = pb.settings;

  // A resumed job keeps what the crashed run already spent and measured.
  const prev = resumed ? pb.meta : undefined;
  const startedAt = now();
  const deadlineAt = startedAt + (deps.timeoutMs ?? 600_000);
  const timings: Record<string, number> = { ...(prev?.timingsMs ?? {}) };
  const tokens: Record<string, number> = { ...(prev?.tokens ?? {}) };
  let cost = prev?.costUsd ?? 0;
  const upstreamFailures: UpstreamFailure[] = [...(prev?.upstreamFailures ?? [])];
  if (!resumed) timings.queue_wait = startedAt - pb.createdAt.getTime();
  const models = {
    pass1: deps.models.standard,
    features: deps.models.pass2,
    playbook: deps.models.pass2,
  };
  const versions = {
    pass1: PASS1_PROMPT_VERSION,
    schema: SCHEMA_VERSION,
    features: FEATURES_VERSION,
    comparison: COMPARISON_VERSION,
    playbook: PLAYBOOK_VERSION,
    manifest: deps.manifest.manifest_version,
  };
  // Each step gets v1's job budget, but never more time than the playbook has left.
  const stepBudget = () =>
    new JobBudget({
      maxFailedAttempts: deps.budget?.maxFailedAttempts ?? 4,
      timeoutMs: Math.max(1, Math.min(deps.budget?.timeoutMs ?? 240_000, deadlineAt - now())),
      now,
    });

  // Cancel, the time limit and a failed step abort every in-flight call at once.
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = (reason: Error) => {
    if (!signal.aborted) controller.abort(reason);
  };
  const deadline = setTimeout(() => abort(new TimedOut()), deadlineAt - now());
  let unsubscribe: (() => Promise<void>) | undefined;
  const stopIfAborted = () => {
    if (signal.aborted) throw signal.reason;
  };

  const save = async (patch: PlaybookPatch) => {
    stopIfAborted();
    const updated = await store.update(pb.id, patch, { onlyIfStatus: RUNNING });
    if (!updated) throw new Cancelled();
    pb = updated;
    await events.publish(pb.id);
  };
  const stage = (s: PlaybookStage, extra: PlaybookPatch = {}) =>
    save({ status: "processing", stage: s, ...extra });
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = now();
    try {
      return await fn();
    } finally {
      timings[name] = (timings[name] ?? 0) + (now() - t);
    }
  };
  let fallbackModelUsed = false;
  const account = async (step: string, u: StepUsage) => {
    tokens[`${step}_input`] = (tokens[`${step}_input`] ?? 0) + u.tokens.input;
    tokens[`${step}_output`] = (tokens[`${step}_output`] ?? 0) + u.tokens.output;
    upstreamFailures.push(...u.upstreamFailures);
    if (u.fallbackUsed) fallbackModelUsed = true;
    if (!deps.pricing) return;
    const usd = costUsd(deps.pricing, u.model, u.tokens);
    cost += usd;
    await deps.spend?.add(usd);
  };
  /** Counts what a failed step spent, when its error carries usage. */
  const accountFailure = async (step: string, e: unknown) => {
    const detail = e instanceof MatchCutError ? e.detail : undefined;
    const usage = detail?.usage;
    for (const u of Array.isArray(usage) ? usage : usage ? [usage] : []) {
      await account(step, u as StepUsage);
    }
    if (Array.isArray(detail?.failures)) {
      upstreamFailures.push(...(detail.failures as UpstreamFailure[]));
    }
  };

  let outcome = "succeeded";
  let errorCode: string | undefined;
  let cached = false;
  let picked = 0;
  let skipped = 0;
  let ungrounded = 0;
  let repairUsed = false;
  let fallbacksUsed = false;
  let writerFailed = false;

  /** A video failed. Per-video problems leave it out; anything else fails the whole playbook. */
  const videoFailed = async (step: "watching" | "extracting", videoId: string, e: unknown) => {
    if (signal.aborted) throw signal.reason;
    // Tokens are counted per model step, as for successful calls.
    await accountFailure(step === "watching" ? "pass1" : "features", e);
    if (e instanceof MatchCutError && e.detail?.repairUsed) repairUsed = true;
    if (!isPerVideoFailure(e)) {
      abort(new StepFailed(asMatchCut(e)));
      throw signal.reason;
    }
    log("playbook video skipped", {
      playbookId: pb.id,
      videoId,
      step,
      code: asMatchCut(e).error.code,
    });
  };

  try {
    unsubscribe = await events.subscribe(pb.id, () => {
      void store
        .get(pb.id)
        .then((p) => {
          if (!p || p.status === "cancelled") abort(new Cancelled());
        })
        // A database blip here must never become an unhandled rejection (it would end the
        // worker process, briefs included). The next write notices a cancel anyway.
        .catch(() => {});
    });

    if (!resumed && timings.queue_wait! > (deps.queueMaxWaitMs ?? 120_000)) {
      throw new MatchCutError("CAPACITY_EXHAUSTED", {}, { reason: "queue_wait" });
    }

    // ---------- 1. Channel ----------
    await stage("resolving_channel");
    const resolved = await timed("resolving_channel", () =>
      deps.channels.resolve(pb.source, { refresh: pb.forceRefresh }),
    );
    if (resolved.status === "not_found") throw new MatchCutError("CHANNEL_NOT_FOUND");
    if (resolved.status === "unavailable") throw youtubeUnavailable(resolved.reason);
    const ch = resolved.channel;
    await save({
      channel: {
        id: ch.id,
        title: ch.title,
        handle: ch.handle,
        subscriberCount: ch.subscriberCount,
        subscriberCountHidden: ch.subscriberCountHidden,
      },
    });

    // The same channel and settings within 24 hours, from any user: no model calls.
    const pbKey = playbookCacheKey({ channelId: ch.id, ...settings, versions, models });
    const hit = pb.forceRefresh ? null : readCachedPlaybook(await kv.get(pbKey));
    if (hit) {
      cached = true;
      timings.total = (timings.total ?? 0) + (now() - startedAt);
      await save({
        ...hit,
        status: "succeeded",
        stage: null,
        progress: null,
        notEnoughData: null,
        error: null,
        meta: {
          models,
          versions,
          cached: true,
          timingsMs: timings,
          tokens,
          costUsd: cost,
          skipped: 0,
        },
      });
      return;
    }

    // ---------- 2. Stats ----------
    await stage("fetching_stats");
    const uploads = await timed("fetching_stats", () =>
      deps.channels.recentUploads(
        ch,
        { maxVideos: settings.maxVideos, windowDays: settings.windowDays },
        { refresh: pb.forceRefresh },
      ),
    );
    if (uploads.status === "unavailable") throw youtubeUnavailable(uploads.reason);

    // ---------- 3. Score and pick (code) ----------
    await stage("scoring");
    const scored = scoreChannel(uploads.videos, {
      now: new Date(now()),
      windowDays: settings.windowDays,
      maxVideos: settings.maxVideos,
      outlierThreshold: settings.outlierThreshold,
    });
    if (!scored.ok) {
      await save({
        window: scored.window,
        notEnoughData: {
          reasons: scored.reasons,
          shortsEligible: scored.window.shortsEligible,
          outliersFound: scored.outliersFound,
          typicalFound: scored.typicalFound,
          minimums: scored.minimums,
        },
      });
      throw new MatchCutError("NOT_ENOUGH_DATA", {}, { reasons: scored.reasons });
    }
    // Warnings start fresh here, so a resumed run can't keep a stale one.
    await save({
      window: scored.window,
      baseline: scored.baseline,
      notEnoughData: null,
      videos: scored.videos.map(toPlaybookVideo),
      warnings: scored.warnings,
    });

    // ---------- 4. Watch each pick (pass 1, shared cache) ----------
    const picks = [
      ...scored.outliers.map((video) => ({ video, group: "outlier" as const })),
      ...scored.typical.map((video) => ({ video, group: "typical" as const })),
    ];
    picked = picks.length;
    let done = 0;
    // Progress is best effort and serialized: a failed write never fails the playbook, and a
    // slower write never puts an older count over a newer one. Only a cancel stops the job.
    let progressChain: Promise<void> = Promise.resolve();
    const progressed = () => {
      done++;
      progressChain = progressChain
        .then(() => (signal.aborted ? undefined : save({ progress: { done, total: picked } })))
        .catch((e: unknown) => {
          if (e instanceof Cancelled) abort(e);
        });
    };
    await stage("watching", { progress: { done: 0, total: picked } });
    const watched = await timed("watching", () =>
      mapLimit(picks, deps.watchConcurrency ?? 3, async ({ video, group }) => {
        stopIfAborted();
        const pass1Key = pass1CacheKey({
          videoId: video.id,
          range: null,
          detail: "standard",
          model: models.pass1,
          promptVersion: PASS1_PROMPT_VERSION,
        });
        try {
          // PRD: force_refresh skips feature and playbook caches; the pass 1 cache still applies.
          // A damaged entry is a miss, not a failed video.
          const raw = await kv.get(pass1Key);
          let fromCache: Pass1Output | null = null;
          try {
            const parsed = raw ? pass1OutputSchema.safeParse(JSON.parse(raw)) : null;
            fromCache = parsed?.success ? parsed.data : null;
          } catch {
            fromCache = null;
          }
          if (fromCache) return { video, group, output: fromCache, pass1Key } satisfies Watched;
          const run = await watchAndValidate(
            analyzer,
            {
              videoId: video.id,
              canonicalUrl: canonicalYouTubeUrl(video.id),
              range: null,
              detail: "standard",
              model: models.pass1,
              durationSeconds: video.durationSeconds,
            },
            video.durationSeconds,
            signal,
            { budget: stepBudget() },
          );
          await account("pass1", {
            model: run.model,
            tokens: run.tokens,
            fallbackUsed: run.fallbackUsed,
            upstreamFailures: run.upstreamFailures,
          });
          if (run.repairUsed) repairUsed = true;
          // As for briefs: only the requested model's results are cached.
          if (!run.fallbackUsed) {
            await kv.set(pass1Key, JSON.stringify(run.output), PASS1_TTL_SECONDS);
          }
          return { video, group, output: run.output, pass1Key } satisfies Watched;
        } catch (e) {
          await videoFailed("watching", video.id, e);
          return null;
        } finally {
          if (!signal.aborted) progressed();
        }
      }),
    );
    await progressChain;
    stopIfAborted();

    // ---------- 5. Features (text, cached per breakdown) ----------
    await stage("extracting");
    const rows = await timed("extracting", () =>
      mapLimit(watched, deps.watchConcurrency ?? 3, async (w) => {
        stopIfAborted();
        if (!w) return null;
        const { spoken_lines_internal: _spoken, ...breakdown } = w.output;
        const fKey = featuresCacheKey(w.pass1Key, {
          model: models.features,
          version: FEATURES_VERSION,
        });
        try {
          const fromCache = pb.forceRefresh ? null : readCachedFeatures(await kv.get(fKey));
          if (fromCache) {
            ungrounded += fromCache.ungrounded;
            return featureRow(fromCache.values, breakdown, w.video.durationSeconds);
          }
          const run = await extractAndGround(
            analyzer,
            { videoId: w.video.id, breakdown, model: models.features },
            signal,
            // One budget per video, so one bad video can't use up the others' retries.
            { budget: stepBudget() },
          );
          for (const u of run.usage) await account("features", u);
          if (run.repairUsed) repairUsed = true;
          ungrounded += run.ungrounded.length;
          if (!run.usage.some((u) => u.fallbackUsed)) {
            await kv.set(
              fKey,
              JSON.stringify({ values: run.values, ungrounded: run.ungrounded }),
              FEATURES_TTL_SECONDS,
            );
          }
          return featureRow(run.values, breakdown, w.video.durationSeconds);
        } catch (e) {
          await videoFailed("extracting", w.video.id, e);
          return null;
        }
      }),
    );

    const usable = watched.flatMap((w, i) =>
      w && rows[i] ? [{ ...w, features: rows[i] as FeatureRow }] : [],
    );
    const outliers = usable.filter((u) => u.group === "outlier");
    const typical = usable.filter((u) => u.group === "typical");
    skipped = picked - usable.length;
    if (outliers.length < MIN_OUTLIERS || typical.length < MIN_TYPICAL) {
      // Only per-video problems get here (passing ones failed the job already).
      throw new MatchCutError("INVALID_MODEL_OUTPUT", {}, { reason: "too_few_analyzed", skipped });
    }
    const comparedIds = new Set(usable.map((u) => u.video.id));
    const extra: PlaybookWarning[] = [];
    if (skipped > 0) extra.push(playbookWarning("VIDEOS_SKIPPED", { count: skipped }));
    if (outliers.length < SMALL_SAMPLE_PICKS || typical.length < SMALL_SAMPLE_PICKS) {
      extra.push(playbookWarning("SMALL_SAMPLE"));
    }

    // ---------- 6. Compare (code) ----------
    await stage("comparing", {
      videos: pb.videos.map((v) => ({ ...v, compared: comparedIds.has(v.id) })),
    });
    const asCompared = (list: typeof usable): ComparedVideo[] =>
      list.map((u) => ({ videoId: u.video.id, title: u.video.title, features: u.features }));
    const result = compareFeatures(asCompared(outliers), asCompared(typical));

    // ---------- 7. Write (text), then validate ----------
    await stage("writing_playbook");
    const facts: PlaybookFacts = {
      rules: result.rules,
      houseStyle: result.houseStyle,
      outlierTopics: result.outlierTopics,
      outliers: outliers.map((u) => {
        const { spoken_lines_internal, ...breakdown } = u.output;
        return {
          videoId: u.video.id,
          analyzedSeconds: u.video.durationSeconds,
          features: u.features,
          breakdown,
          spokenLines: spoken_lines_internal,
        };
      }),
      avoidNames: [ch.title, ...(ch.handle ? [`@${ch.handle}`] : [])],
    };
    const factIssues = factsProblems(facts);
    if (factIssues.length) {
      throw new MatchCutError("INTERNAL", {}, { step: "facts", problems: factIssues });
    }
    let content: PlaybookContent;
    if (needsPlaybookWriting(facts)) {
      const run = await timed("writing_playbook", () =>
        writeAndCheck(
          analyzer,
          { facts, manifest: deps.manifest, language: "en", model: models.playbook },
          () => stage("validating"),
          signal,
          { budget: stepBudget() },
          (msg, more) => log(msg, { playbookId: pb.id, ...more }),
        ),
      );
      for (const u of run.usage) await account("playbook", u);
      if (run.writerError) {
        await accountFailure("playbook", run.writerError);
        if (run.writerError.detail?.billing) {
          log("ALERT: Gemini billing problem; every model is refusing requests", {});
        }
      }
      if (run.repairUsed) repairUsed = true;
      writerFailed = run.writerFailed;
      fallbacksUsed = run.writerFailed || !run.check.ok;
      content = run.check.content;
    } else {
      // No rule qualified: nothing for the model to write.
      await stage("validating");
      content = checkPlaybook(null, facts).content;
    }

    // ---------- 8. Faithfulness, then save ----------
    const unfaithful = faithfulnessProblems(content, facts);
    if (unfaithful.length) {
      log("ALERT: playbook failed its faithfulness check", {
        playbookId: pb.id,
        problems: unfaithful,
      });
      throw new MatchCutError("INTERNAL", {}, { step: "faithfulness", problems: unfaithful });
    }

    const { warnings: contentWarnings, ...stored } = content;
    const comparison: PlaybookComparison = {
      table: result.table,
      rules: result.rules,
      houseStyle: result.houseStyle,
      outlierTopics: result.outlierTopics,
      features: usable.map((u) => ({ videoId: u.video.id, group: u.group, features: u.features })),
    };
    const warnings = addWarnings(pb.warnings, [...extra, ...result.warnings, ...contentWarnings]);
    const spokenLines = outliers.flatMap((u) => u.output.spoken_lines_internal);
    timings.total = (timings.total ?? 0) + (now() - startedAt);
    await save({
      status: "succeeded",
      stage: null,
      progress: null,
      content: stored,
      comparison,
      spokenLines,
      warnings,
      error: null,
      meta: {
        models,
        versions,
        cached: false,
        timingsMs: timings,
        tokens,
        costUsd: cost,
        ungrounded,
        repairUsed,
        fallbacksUsed,
        writerFailed,
        fallbackModelUsed,
        skipped,
        upstreamFailures,
      },
    });
    // Shared for 24 hours, unless a fallback model, fallback wording or a skipped video made it.
    if (!fallbackModelUsed && !fallbacksUsed && skipped === 0) {
      const toCache: CachedPlaybook = {
        channel: pb.channel,
        window: pb.window,
        baseline: pb.baseline,
        videos: pb.videos,
        comparison,
        content: stored,
        spokenLines,
        warnings,
      };
      try {
        await kv.set(pbKey, JSON.stringify(toCache), PLAYBOOK_TTL_SECONDS);
      } catch (e) {
        log("playbook cache write failed", { playbookId: pb.id, err: String(e) });
      }
    }
  } catch (caught) {
    const reason = signal.aborted ? signal.reason : caught;
    if (reason instanceof Cancelled || caught instanceof Cancelled) {
      outcome = "cancelled";
      return;
    }
    let err: unknown = reason;
    if (reason instanceof TimedOut) {
      err = new MatchCutError("UPSTREAM_TIMEOUT", {}, { reason: "playbook_timeout" });
    } else if (reason instanceof StepFailed) {
      err = reason.cause;
    } else if (!(err instanceof MatchCutError)) {
      log("unexpected playbook pipeline error", { playbookId: pb.id, err: String(err) });
    }
    // Stop anything still running before writing the failure.
    abort(new JobEnded());
    const error: ApiError = err instanceof MatchCutError ? err.error : apiError("INTERNAL");
    const detail = (err instanceof MatchCutError ? err.detail : undefined) ?? {};
    errorCode = error.code;
    outcome = "failed";
    timings.total = (timings.total ?? 0) + (now() - startedAt);
    if (Array.isArray(detail.failures)) {
      upstreamFailures.push(...(detail.failures as UpstreamFailure[]));
    }
    const failure: NonNullable<PlaybookMeta["failure"]> = {
      code: error.code,
      ...(typeof detail.status === "number" ? { upstreamStatus: detail.status } : {}),
      ...(typeof detail.finishReason === "string" ? { finishReason: detail.finishReason } : {}),
      ...(typeof detail.attempts === "number" ? { attempts: detail.attempts } : {}),
    };
    try {
      const failed = await store.update(
        pb.id,
        {
          status: "failed",
          stage: null,
          progress: null,
          error,
          meta: {
            ...pb.meta,
            models,
            versions,
            timingsMs: timings,
            tokens,
            costUsd: cost,
            skipped,
            upstreamFailures,
            lastErrorCode: error.code,
            failure,
          },
        },
        { onlyIfStatus: RUNNING },
      );
      if (!failed) outcome = "cancelled";
      else {
        await events.publish(pb.id);
        if (NOT_USERS_FAULT.has(error.code) && deps.refund) await deps.refund(failed);
      }
    } catch (e) {
      log("ALERT: could not record a playbook failure", { playbookId: pb.id, err: String(e) });
    }
    if (detail.billing) log("ALERT: Gemini billing problem; every model is refusing requests", {});
  } finally {
    clearTimeout(deadline);
    abort(new JobEnded());
    await unsubscribe?.().catch(() => {});
    // One line per job for dashboards. No titles or channel input.
    log("playbook finished", {
      playbookId: pb.id,
      userId: pb.userId,
      orgId: pb.orgId,
      channelId: pb.channel?.id ?? null,
      outcome,
      errorCode,
      settings,
      cached,
      picked,
      skipped,
      rules: pb.content?.rules.length ?? null,
      ungrounded,
      repairUsed,
      fallbacksUsed,
      writerFailed,
      fallbackModelUsed,
      models,
      versions,
      timingsMs: timings,
      tokens,
      costUsd: Number(cost.toFixed(6)),
      upstreamFailures: upstreamFailures.length,
      warnings: pb.warnings.map((w) => w.code),
      resumed,
    });
  }
}
