/**
 * Video state and clip-range rules. PRD: "Backend: input validation and edge cases"
 * (Video state, Length and clip range). Pure: the precheck supplies the metadata.
 */
import type { ErrorCode, WarningCode } from "./errors.js";
import { formatTimecode } from "./timecode.js";

/** What the precheck learns about a video from the YouTube Data API. */
export interface VideoMetadata {
  id: string;
  title: string;
  channel: string;
  thumbnailUrl: string | null;
  /** 0 for live streams and unaired premieres. */
  durationSeconds: number;
  privacyStatus: "public" | "unlisted" | "private";
  embeddable: boolean;
  ageRestricted: boolean;
  regionRestriction: { allowed?: string[]; blocked?: string[] } | null;
  liveBroadcastContent: "none" | "live" | "upcoming";
}

export interface Limits {
  /** Longest video analyzed whole without a clip range. PRD: 20 minutes. */
  maxVideoSeconds: number;
  /** Longest clip range. PRD: 10 minutes. */
  maxClipSeconds: number;
  /** Shortest clip range. PRD: 3 seconds. */
  minRangeSeconds: number;
  /** Videos this long or shorter have nothing to analyze. PRD: 3 seconds. */
  minVideoSeconds: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxVideoSeconds: 20 * 60,
  maxClipSeconds: 10 * 60,
  minRangeSeconds: 3,
  minVideoSeconds: 3,
};

export function isBlockedInRegion(meta: VideoMetadata, region: string): boolean {
  const r = meta.regionRestriction;
  if (!r) return false;
  const code = region.toUpperCase();
  if (r.allowed && !r.allowed.map((c) => c.toUpperCase()).includes(code)) return true;
  if (r.blocked?.map((c) => c.toUpperCase()).includes(code)) return true;
  return false;
}

export interface VideoStateResult {
  /** A blocking error, or null when the video can be analyzed. */
  error: Extract<
    ErrorCode,
    "VIDEO_NOT_PUBLIC" | "VIDEO_RESTRICTED" | "LIVE_NOT_SUPPORTED" | "NO_ANALYZABLE_CONTENT"
  > | null;
  warnings: WarningCode[];
}

/** Classifies a found video. Not-found is handled by the caller (no metadata). */
export function classifyVideoState(
  meta: VideoMetadata,
  region: string,
  limits: Limits = DEFAULT_LIMITS,
): VideoStateResult {
  const warnings: WarningCode[] = meta.embeddable ? [] : ["EMBED_DISABLED"];
  if (meta.privacyStatus !== "public") return { error: "VIDEO_NOT_PUBLIC", warnings };
  // Live checks come before length: live streams and premieres report a duration of 0.
  if (meta.liveBroadcastContent !== "none") return { error: "LIVE_NOT_SUPPORTED", warnings };
  if (meta.ageRestricted || isBlockedInRegion(meta, region)) {
    return { error: "VIDEO_RESTRICTED", warnings };
  }
  if (meta.durationSeconds <= limits.minVideoSeconds) {
    return { error: "NO_ANALYZABLE_CONTENT", warnings };
  }
  return { error: null, warnings };
}

export interface ClipInput {
  start_seconds?: number;
  end_seconds?: number;
}

export interface AnalyzedRange {
  start_seconds: number;
  end_seconds: number;
}

export type ClipResult =
  | {
      ok: true;
      range: AnalyzedRange | null;
      warnings: { code: WarningCode; vars?: Record<string, string> }[];
    }
  | { ok: false; code: Extract<ErrorCode, "INVALID_CLIP_RANGE" | "VIDEO_TOO_LONG"> };

/**
 * Works out the range to analyze. `durationSeconds` is undefined when the precheck was skipped
 * (YouTube Data API down); then only checks that don't need the duration run.
 * Returns range null when the whole video is analyzed.
 */
export function resolveClipRange(
  clip: ClipInput | undefined,
  durationSeconds: number | undefined,
  limits: Limits = DEFAULT_LIMITS,
): ClipResult {
  const bad = { ok: false, code: "INVALID_CLIP_RANGE" } as const;
  const start = clip?.start_seconds;
  const end = clip?.end_seconds;
  const isInt = (n: number | undefined) => n === undefined || (Number.isInteger(n) && n >= 0);
  if (!isInt(start) || !isInt(end)) return bad;

  // No clip: whole video, if it is short enough.
  if (start === undefined && end === undefined) {
    if (durationSeconds !== undefined && durationSeconds > limits.maxVideoSeconds) {
      return { ok: false, code: "VIDEO_TOO_LONG" };
    }
    return { ok: true, range: null, warnings: [] };
  }

  const s = start ?? 0;
  if (end !== undefined && end - s < limits.minRangeSeconds) return bad;

  if (durationSeconds === undefined) {
    if (end === undefined) {
      return {
        ok: true,
        range: { start_seconds: s, end_seconds: s + limits.maxClipSeconds },
        warnings: [],
      };
    }
    if (end - s > limits.maxClipSeconds) return bad;
    return { ok: true, range: { start_seconds: s, end_seconds: end }, warnings: [] };
  }

  if (s >= durationSeconds) return bad;

  const warnings: { code: WarningCode; vars?: Record<string, string> }[] = [];
  let e: number;
  if (end === undefined) {
    // Start only: analyze to the end, capped at the clip limit.
    e = Math.min(durationSeconds, s + limits.maxClipSeconds);
  } else if (end > durationSeconds) {
    e = durationSeconds;
    warnings.push({ code: "CLIP_CLAMPED", vars: { duration: formatTimecode(durationSeconds) } });
  } else {
    e = end;
  }

  if (e - s < limits.minRangeSeconds || e - s > limits.maxClipSeconds) return bad;
  return { ok: true, range: { start_seconds: s, end_seconds: e }, warnings };
}
