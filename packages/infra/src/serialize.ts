import {
  PASS1_PROMPT_VERSION,
  PASS2_PROMPT_VERSION,
  SCHEMA_VERSION,
  type BriefResponse,
  type PlaybookResponse,
  type SkillResponse,
  type SkillSnapshotResponse,
  type SkillSummaryResponse,
} from "@match-cut/core";
import type { BriefRecord, PlaybookRecord, SkillRecord } from "./types.js";

/** The API's brief object. Goal, spoken lines and internal meta are deliberately left out. */
export function toBriefResponse(r: BriefRecord): BriefResponse {
  const duration = r.video?.durationSeconds ?? null;
  const analyzed =
    r.range ?? (duration !== null ? { start_seconds: 0, end_seconds: duration } : null);
  return {
    id: r.id,
    status: r.status,
    stage: r.status === "processing" || r.status === "queued" ? r.stage : null,
    video: {
      id: r.videoId,
      title: r.video?.title ?? null,
      channel: r.video?.channel ?? null,
      duration_seconds: duration,
      aspect_ratio: r.breakdown?.format.aspect_ratio ?? null,
      analyzed_range: analyzed,
    },
    breakdown: r.breakdown,
    cardboard_prompt: r.prompt?.cardboard_prompt ?? null,
    assets_needed: r.prompt?.assets_needed ?? null,
    watch_outs: r.prompt?.watch_outs ?? null,
    shot_list: r.prompt?.shot_list ?? null,
    warnings: r.warnings,
    error: r.error,
    meta: {
      model: r.meta.model,
      prompt_version: `${PASS1_PROMPT_VERSION}+${PASS2_PROMPT_VERSION}`,
      schema_version: SCHEMA_VERSION,
      cached: r.meta.cached,
      timings_ms: r.meta.timingsMs,
      tokens: r.meta.tokens,
      created_at: r.createdAt.toISOString(),
    },
  };
}

const inFlight = (status: string) => status === "processing" || status === "queued";

/**
 * The API's playbook object (PRD-playbooks.md, Playbook object). Spoken lines, the parsed source,
 * the comparison internals and failure details stay in the backend. Long uploads aren't listed
 * (MIXED_FORMATS warns about them); uploads under 7 days old are listed as "other" with no score.
 */
export function toPlaybookResponse(r: PlaybookRecord): PlaybookResponse {
  return {
    id: r.id,
    status: r.status,
    stage: inFlight(r.status) ? r.stage : null,
    progress: inFlight(r.status) && r.stage === "watching" ? r.progress : null,
    channel: r.channel && {
      id: r.channel.id,
      title: r.channel.title,
      handle: r.channel.handle,
      subscriber_count_rounded: r.channel.subscriberCount,
      subscriber_count_hidden: r.channel.subscriberCountHidden,
    },
    window: r.window && {
      from: r.window.from,
      to: r.window.to,
      uploads_seen: r.window.uploadsSeen,
      shorts_eligible: r.window.shortsEligible,
      too_new: r.window.tooNew,
    },
    baseline: r.baseline && {
      median_views: r.baseline.medianViews,
      median_engagement_rate: r.baseline.medianEngagementRate,
    },
    videos: r.videos
      .filter((v) => v.group !== "not_short")
      .map((v) => ({
        id: v.id,
        title: v.title,
        published_at: v.publishedAt,
        views: v.views,
        likes: v.likes,
        comments: v.comments,
        outlier_score: v.group === "too_new" ? null : v.outlierScore,
        group: v.group === "outlier" || v.group === "typical" ? v.group : "other",
        brief_id: v.briefId,
      })),
    not_enough_data: r.notEnoughData && {
      reasons: r.notEnoughData.reasons,
      found: {
        shorts_eligible: r.notEnoughData.shortsEligible,
        outliers: r.notEnoughData.outliersFound,
        typical: r.notEnoughData.typicalFound,
      },
      minimums: {
        shorts_eligible: r.notEnoughData.minimums.eligible,
        outliers: r.notEnoughData.minimums.outliers,
        typical: r.notEnoughData.minimums.typical,
      },
    },
    rules: r.content?.rules ?? null,
    house_style: r.content?.house_style ?? null,
    not_explained: r.content?.not_explained ?? null,
    recipe_prompt_template: r.content?.recipe_prompt_template ?? null,
    warnings: r.warnings,
    error: r.error,
    meta: {
      versions: r.meta.versions,
      models: r.meta.models,
      cached: r.meta.cached,
      timings_ms: r.meta.timingsMs,
      tokens: r.meta.tokens,
      cost_usd: r.meta.costUsd ?? null,
      created_at: r.createdAt.toISOString(),
    },
  };
}

/** A skill as the skills list shows it: name, source, last used. */
export function toSkillSummary(r: SkillRecord): SkillSummaryResponse {
  return {
    id: r.id,
    name: r.name,
    source: { type: r.source.type, id: r.source.id, title: r.sourceTitle },
    last_used_at: r.lastUsedAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

/** A skill with its snapshot. Speech fingerprints stay internal. */
export function toSkillResponse(r: SkillRecord): SkillResponse {
  const s = r.snapshot;
  const snapshot: SkillSnapshotResponse =
    s.type === "brief"
      ? {
          type: "brief",
          generated_at: s.generatedAt,
          video_id: s.videoId,
          video_title: s.videoTitle,
          breakdown: s.breakdown,
        }
      : {
          type: "playbook",
          generated_at: s.generatedAt,
          channel: s.channel,
          settings: {
            window_days: s.settings.windowDays,
            max_videos: s.settings.maxVideos,
            outlier_threshold: s.settings.outlierThreshold,
          },
          window: s.window,
          rules: s.rules,
          house_style: s.houseStyle,
          not_explained: s.notExplained,
          recipe_prompt_template: s.recipePromptTemplate,
          warnings: s.warnings,
        };
  return { ...toSkillSummary(r), snapshot, versions: r.versions };
}
