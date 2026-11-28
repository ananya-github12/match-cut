/**
 * Error and warning codes, HTTP statuses and user-facing copy.
 * Source: PRD "Backend: API contract" (error codes) and
 * "Frontend requirements > Error, warning and empty-state copy". Copy must match the PRD exactly.
 */

export const ERRORS = {
  INVALID_URL: { http: 400, retryable: false, message: "That doesn't look like a YouTube link." },
  UNSUPPORTED_SOURCE: {
    http: 400,
    retryable: false,
    message: "Match Cut works with single YouTube videos for now. Instagram and TikTok are coming.",
  },
  INVALID_CLIP_RANGE: {
    http: 400,
    retryable: false,
    message: "The end time needs to be at least 3 seconds after the start, within 10 minutes.",
  },
  GOAL_TOO_LONG: {
    http: 400,
    retryable: false,
    message: "Keep the description under 1,500 characters.",
  },
  UNAUTHORIZED: { http: 401, retryable: false, message: "Your session has ended." },
  VIDEO_NOT_FOUND: {
    http: 404,
    retryable: false,
    message: "This video has been removed or the link is wrong.",
  },
  // PRD-playbooks.md, "New error codes".
  CHANNEL_NOT_FOUND: {
    http: 404,
    retryable: false,
    message: "We couldn't find that channel. Check the handle or paste one of its video links.",
  },
  NOT_ENOUGH_DATA: {
    http: 422,
    retryable: false,
    message:
      "This channel doesn't have enough recent Shorts to compare yet. Try a longer time window, or analyze a single video instead.",
  },
  VIDEO_NOT_PUBLIC: {
    http: 422,
    retryable: false,
    message: "This video is private or unlisted. Match Cut can only watch public videos.",
  },
  VIDEO_RESTRICTED: {
    http: 422,
    retryable: false,
    message: "This video is age-restricted or blocked in our region.",
  },
  // PRD lists retryable as "Later"; the API field is boolean, so false + a message saying when.
  LIVE_NOT_SUPPORTED: {
    http: 422,
    retryable: false,
    message: "This video is live or hasn't premiered yet. Try again once it has ended.",
  },
  VIDEO_TOO_LONG: {
    http: 422,
    retryable: false,
    message: "This video is over 20 minutes. Pick the part you want, up to 10 minutes.",
  },
  NO_ANALYZABLE_CONTENT: {
    http: 422,
    retryable: false,
    message: "There isn't enough in this video to study. It may be too short or blank.",
  },
  CONTENT_BLOCKED: { http: 422, retryable: false, message: "This video can't be analyzed." },
  RATE_LIMITED: {
    http: 429,
    retryable: true,
    message: "You've reached the limit for now. You can match another video in {minutes} minutes.",
  },
  UPSTREAM_ERROR: {
    http: 502,
    retryable: true,
    message: "Something went wrong while analyzing.",
  },
  INVALID_MODEL_OUTPUT: {
    http: 502,
    retryable: true,
    message: "Something went wrong while analyzing.",
  },
  CAPACITY_EXHAUSTED: {
    http: 503,
    retryable: true,
    message: "Match Cut is at capacity. Try again in a few minutes.",
  },
  UPSTREAM_TIMEOUT: {
    http: 504,
    retryable: true,
    message: "This took too long. Shorter sections work faster.",
  },
  INTERNAL: { http: 500, retryable: true, message: "Something went wrong while analyzing." },

  // ---- Not in the PRD's error table; added in M2, pending sign-off. ----
  /** Request body fails validation in a way no PRD code covers (bad format, length, language). */
  INVALID_REQUEST: {
    http: 400,
    retryable: false,
    message: "Something in the request isn't valid.",
  },
  /** Unknown brief ID, or one owned by another user. */
  BRIEF_NOT_FOUND: {
    http: 404,
    retryable: false,
    message: "This brief doesn't exist or was deleted.",
  },
  /** Regenerate called while the brief is still running, or before it has a breakdown. */
  BRIEF_NOT_READY: {
    http: 409,
    retryable: true,
    message: "This brief is still being worked on. Try again when it finishes.",
  },
  // ---- PRD-playbooks.md, API additions. ----
  /** `source.mine` without a connected channel. Until M11 nobody can connect one. */
  YOUTUBE_NOT_CONNECTED: {
    http: 403,
    retryable: false,
    message: "Connect your YouTube channel to analyze your own videos.",
  },
  // ---- Added in M10.7, pending sign-off. ----
  /** Unknown playbook ID, or one owned by another user. */
  PLAYBOOK_NOT_FOUND: {
    http: 404,
    retryable: false,
    message: "This playbook doesn't exist or was deleted.",
  },
  /** Apply or save called while the playbook is still running, or after it failed. */
  PLAYBOOK_NOT_READY: {
    http: 409,
    retryable: true,
    message: "This playbook is still being worked on. Try again when it finishes.",
  },
  /** Apply or save on a playbook that failed or was cancelled: retrying won't help. */
  PLAYBOOK_NOT_AVAILABLE: {
    http: 409,
    retryable: false,
    message: "This playbook didn't finish, so there's nothing to apply or save. Start a new one.",
  },
  /** Apply or save on a playbook whose comparison kept no rule (NO_CLEAR_PATTERN). */
  PLAYBOOK_HAS_NO_RULES: {
    http: 422,
    retryable: false,
    message: "This playbook didn't find a clear pattern, so there's nothing to apply or save.",
  },
  /** Unknown skill ID, or one owned by another user. */
  SKILL_NOT_FOUND: {
    http: 404,
    retryable: false,
    message: "This skill doesn't exist or was deleted.",
  },
  /** PRD: 50 skills per user. */
  SKILL_LIMIT_REACHED: {
    http: 409,
    retryable: false,
    message: "You can save up to {limit} skills. Delete one to save another.",
  },
} as const satisfies Record<string, { http: number; retryable: boolean; message: string }>;

export type ErrorCode = keyof typeof ERRORS;

export const WARNINGS = {
  CLIP_CLAMPED: "Your end time was past the end of the video, so we analyzed up to {duration}.",
  TIMESTAMP_IGNORED: "The link's start time was ignored. Set a clip range to analyze one part.",
  NO_SPEECH: "No speech found, so the prompt focuses on pacing, music and graphics.",
  LOW_VISUAL_SIGNAL:
    "The video is mostly a still picture, so there was little visual style to copy.",
  EMBED_DISABLED: "The creator has turned off playback outside YouTube.",
  SHOT_LIST_UNAVAILABLE:
    "We couldn't build a shot list for this video. Regenerate the prompt to try again.",
} as const;

export type WarningCode = keyof typeof WARNINGS;

/**
 * Apply's wording where v1's doesn't fit (drafted in M10; needs owner sign-off): apply has no
 * "Regenerate" action and isn't about one video.
 */
export const APPLY_WARNINGS = {
  SHOT_LIST_UNAVAILABLE:
    "We couldn't build a shot list this time. Write the prompt again to get one.",
} as const satisfies Partial<Record<WarningCode, string>>;

/** A warning on an apply result: apply's wording when it has its own. */
export function applyWarning(code: WarningCode): Warning {
  const own = (APPLY_WARNINGS as Partial<Record<WarningCode, string>>)[code];
  return own ? { code, message: own } : warning(code);
}

/** Playbook warnings (PRD-playbooks.md, playbook object `warnings[]`). */
export const PLAYBOOK_WARNINGS = {
  SMALL_SAMPLE: "Only a few videos could be compared, so treat these patterns as early signals.",
  MIXED_FORMATS: "This channel also posts long videos; only its Shorts were compared.",
  LIKES_HIDDEN:
    "Some of the compared videos hide their likes, so their engagement counts comments only.",
  RECENT_VIDEOS_EXCLUDED:
    "{count} uploads from the last {days} days were left out because they're still gaining views.",
  TOPIC_CONFOUND: "Most breakouts share a topic, so the topic may matter as much as the edit.",
  RECIPE_UNAVAILABLE:
    "We couldn't write a ready-made prompt for this playbook. Use Apply to write one for your goal.",
  VIDEOS_SKIPPED:
    "{count} of the picked videos couldn't be analyzed, so they were left out of the comparison.",
  NO_CLEAR_PATTERN:
    "We couldn't find an edit choice that clearly sets the breakouts apart from typical videos, so there are no rules to copy yet.",
} as const;

export type PlaybookWarningCode = keyof typeof PLAYBOOK_WARNINGS;

export interface ApiError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface Warning {
  code: WarningCode;
  message: string;
}

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function apiError(code: ErrorCode, vars: Record<string, string | number> = {}): ApiError {
  const e = ERRORS[code];
  return { code, message: fill(e.message, vars), retryable: e.retryable };
}

export function warning(code: WarningCode, vars: Record<string, string | number> = {}): Warning {
  return { code, message: fill(WARNINGS[code], vars) };
}

/** Thrown inside the backend; routes turn it into `{ error }` with the mapped HTTP status. */
export class MatchCutError extends Error {
  readonly error: ApiError;
  readonly http: number;
  /** Internal debugging detail (upstream status, finish reason). Logged, never sent to users. */
  readonly detail?: Record<string, unknown>;
  constructor(
    code: ErrorCode,
    vars: Record<string, string | number> = {},
    detail?: Record<string, unknown>,
  ) {
    const e = apiError(code, vars);
    super(e.message);
    this.name = "MatchCutError";
    this.error = e;
    this.http = ERRORS[code].http;
    this.detail = detail;
  }
}

export interface PlaybookWarning {
  code: PlaybookWarningCode;
  message: string;
}

export function playbookWarning(
  code: PlaybookWarningCode,
  vars: Record<string, string | number> = {},
): PlaybookWarning {
  return { code, message: fill(PLAYBOOK_WARNINGS[code], vars) };
}
