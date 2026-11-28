/**
 * PRD "Error, warning and empty-state copy": every code maps to one plain message and one action.
 * Messages always come from the PRD table in @match-cut/core/errors, never from server text.
 */
import { ERRORS, WARNINGS, type ErrorCode, type WarningCode } from "@match-cut/core/errors";
import { formatTimecode } from "@match-cut/core/timecode";
import { S } from "./strings";

export type ErrorAction =
  | "focusLink"
  | "openClip"
  | "focusGoal"
  | "signIn"
  | "tryAnother"
  | "retry"
  | "countdown"
  | "openClipAndRetry"
  | "retryWhenOnline";

const ACTIONS: Record<string, ErrorAction> = {
  INVALID_URL: "focusLink",
  UNSUPPORTED_SOURCE: "focusLink",
  INVALID_CLIP_RANGE: "openClip",
  GOAL_TOO_LONG: "focusGoal",
  UNAUTHORIZED: "signIn",
  VIDEO_NOT_FOUND: "tryAnother",
  VIDEO_NOT_PUBLIC: "tryAnother",
  VIDEO_RESTRICTED: "tryAnother",
  LIVE_NOT_SUPPORTED: "tryAnother",
  VIDEO_TOO_LONG: "openClip",
  NO_ANALYZABLE_CONTENT: "tryAnother",
  CONTENT_BLOCKED: "tryAnother",
  RATE_LIMITED: "countdown",
  CAPACITY_EXHAUSTED: "retry",
  UPSTREAM_TIMEOUT: "openClipAndRetry",
  UPSTREAM_ERROR: "retry",
  INVALID_MODEL_OUTPUT: "retry",
  INTERNAL: "retry",
  OFFLINE: "retryWhenOnline",
  // PRD-playbooks.md.
  CHANNEL_NOT_FOUND: "focusLink",
  NOT_ENOUGH_DATA: "tryAnother",
  YOUTUBE_NOT_CONNECTED: "tryAnother",
  PLAYBOOK_NOT_FOUND: "tryAnother",
  PLAYBOOK_NOT_AVAILABLE: "tryAnother",
  PLAYBOOK_HAS_NO_RULES: "tryAnother",
  SKILL_NOT_FOUND: "tryAnother",
  SKILL_LIMIT_REACHED: "tryAnother",
};

/** Codes the user fixes in the input panel (shown under the field, before or after submit). */
export const INPUT_CODES = new Set([
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
]);

export interface UiError {
  code: string;
  message: string;
  action: ErrorAction;
  retryAfterSeconds?: number;
}

export function uiError(code: string, retryAfterSeconds?: number): UiError {
  if (code === "OFFLINE") return { code, message: S.offline, action: "retryWhenOnline" };
  // Codes outside the PRD table (and anything unknown) read as the generic retryable message.
  const known = code in ERRORS ? (code as ErrorCode) : "INTERNAL";
  let message: string = ERRORS[known].message;
  if (known === "RATE_LIMITED") {
    const minutes = Math.max(1, Math.ceil((retryAfterSeconds ?? 60) / 60));
    message = message.replace("{minutes}", String(minutes));
  }
  // PRD-playbooks.md: 50 skills per user.
  message = message.replace("{limit}", "50");
  return { code: known, message, action: ACTIONS[known] ?? "retry", retryAfterSeconds };
}

export function warningText(code: string, vars: { duration?: number } = {}): string | null {
  if (!(code in WARNINGS)) return null;
  const text: string = WARNINGS[code as WarningCode];
  return text.replace(
    "{duration}",
    vars.duration !== undefined ? formatTimecode(vars.duration) : "the end",
  );
}
