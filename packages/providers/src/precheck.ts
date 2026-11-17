/**
 * Precheck: runs before any Gemini call. PRD: "Backend: input validation and edge cases".
 */
import {
  classifyVideoState,
  DEFAULT_LIMITS,
  resolveClipRange,
  type AnalyzedRange,
  type ClipInput,
  type ErrorCode,
  type Limits,
  type VideoMetadata,
  type WarningCode,
} from "@match-cut/core";
import type { VideoLookup } from "./youtube/types.js";

export interface PrecheckOptions {
  region: string;
  limits?: Limits;
}

export type PrecheckWarning = { code: WarningCode; vars?: Record<string, string> };

export type VideoCheck =
  | { ok: true; video: VideoMetadata | null; skipped: boolean; warnings: PrecheckWarning[] }
  | { ok: false; code: ErrorCode; video: VideoMetadata | null };

/** Video state only: used by the preview endpoint, before the user picks a clip range. */
export async function checkVideo(
  lookup: VideoLookup,
  videoId: string,
  opts: PrecheckOptions,
): Promise<VideoCheck> {
  const result = await lookup.lookup(videoId);
  if (result.status === "not_found") return { ok: false, code: "VIDEO_NOT_FOUND", video: null };
  if (result.status === "unavailable")
    return { ok: true, video: null, skipped: true, warnings: [] };
  const state = classifyVideoState(result.video, opts.region, opts.limits ?? DEFAULT_LIMITS);
  if (state.error) return { ok: false, code: state.error, video: result.video };
  return {
    ok: true,
    video: result.video,
    skipped: false,
    warnings: state.warnings.map((code) => ({ code })),
  };
}

export type PrecheckResult =
  | {
      ok: true;
      video: VideoMetadata | null;
      /** True when the Data API was unavailable and the precheck was skipped. */
      skipped: boolean;
      /** Null means the whole video. */
      range: AnalyzedRange | null;
      warnings: PrecheckWarning[];
    }
  | { ok: false; code: ErrorCode; video: VideoMetadata | null };

/** Full precheck for a brief: video state, then length caps and clip range. */
export async function precheck(
  lookup: VideoLookup,
  videoId: string,
  clip: ClipInput | undefined,
  opts: PrecheckOptions,
): Promise<PrecheckResult> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const v = await checkVideo(lookup, videoId, { ...opts, limits });
  if (!v.ok) return v;
  const c = resolveClipRange(clip, v.video?.durationSeconds, limits);
  if (!c.ok) return { ok: false, code: c.code, video: v.video };
  return {
    ok: true,
    video: v.video,
    skipped: v.skipped,
    range: c.range,
    warnings: [...v.warnings, ...c.warnings],
  };
}
