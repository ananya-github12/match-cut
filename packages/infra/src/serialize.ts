import {
  PASS1_PROMPT_VERSION,
  PASS2_PROMPT_VERSION,
  SCHEMA_VERSION,
  type BriefResponse,
} from "@match-cut/core";
import type { BriefRecord } from "./types.js";

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
