/**
 * Playbook and skill API shapes. PRD-playbooks.md: "API additions", "Playbook object (API
 * response)" and "Feature 4: Saved skills". Requests are validated with Zod; responses are typed.
 */
import { z } from "zod";
import type { Breakdown, BriefStatus } from "../schemas.js";
import type { PlaybookRule } from "./writing.js";
import {
  MIN_AGE_DAYS,
  PLAYBOOK_DEFAULTS,
  PLAYBOOK_LIMITS,
  type NotEnoughDataReason,
} from "./scoring.js";

/** Re-exported for the web app (its copy names the age rule): uploads younger aren't scored. */
export { MIN_AGE_DAYS };

/** PRD stage list, in order. `watching` carries progress {done, total}. */
export const PLAYBOOK_STAGES = [
  "resolving_channel",
  "fetching_stats",
  "scoring",
  "watching",
  "extracting",
  "comparing",
  "writing_playbook",
  "validating",
] as const;
export type PlaybookStage = (typeof PLAYBOOK_STAGES)[number];

/** PRD: "Handle, channel URL or video URL, max 2,048 characters". */
export const CHANNEL_INPUT_MAX_CHARS = 2048;

/** Length in characters (code points), as users count them; .max() counts UTF-16 units. */
const chars = (s: string) => [...s].length;

/**
 * POST /v1/playbooks. `source` is a channel (handle, channel URL or video URL) or `mine: true`
 * (own channel, M11). Until M11, the route answers `mine` with YOUTUBE_NOT_CONNECTED, as the PRD
 * defines, so clients can build against the final contract.
 */
export const createPlaybookRequestSchema = z
  .object({
    source: z.union([
      z
        .object({
          channel: z
            .string()
            .trim()
            .min(1)
            .refine((s) => chars(s) <= CHANNEL_INPUT_MAX_CHARS, {
              message: `at most ${CHANNEL_INPUT_MAX_CHARS} characters`,
            }),
        })
        .strict(),
      z.object({ mine: z.literal(true) }).strict(),
    ]),
    window_days: z
      .number()
      .int()
      .min(PLAYBOOK_LIMITS.windowDays[0])
      .max(PLAYBOOK_LIMITS.windowDays[1])
      .default(PLAYBOOK_DEFAULTS.windowDays),
    max_videos: z
      .number()
      .int()
      .min(PLAYBOOK_LIMITS.maxVideos[0])
      .max(PLAYBOOK_LIMITS.maxVideos[1])
      .default(PLAYBOOK_DEFAULTS.maxVideos),
    outlier_threshold: z
      .number()
      .min(PLAYBOOK_LIMITS.outlierThreshold[0])
      .max(PLAYBOOK_LIMITS.outlierThreshold[1])
      .default(PLAYBOOK_DEFAULTS.outlierThreshold),
    force_refresh: z.boolean().default(false),
  })
  .strict();
export type CreatePlaybookRequest = z.infer<typeof createPlaybookRequestSchema>;

/** PRD: "50 skills per user". */
export const SKILLS_PER_USER = 50;

/** Why there's too little data, in words (drafted in M10.9; needs owner sign-off). */
export const NOT_ENOUGH_DATA_REASON_COPY: Record<string, string> = {
  TOO_FEW_SHORTS: "Too few recent Shorts",
  TOO_FEW_BREAKOUTS: "Too few breakouts",
  TOO_FEW_TYPICAL: "Too few typical Shorts",
  NO_VIEWS: "No view counts",
};
export const SKILL_NAME_MAX_CHARS = 80;

/**
 * A skill name as shown in lists: NFC, no control or invisible formatting characters (zero-width,
 * bidi overrides), whitespace collapsed and trimmed.
 */
export function cleanSkillName(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (/\s/.test(c) ? " " : ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** POST /v1/skills: save a brief's breakdown or a playbook's rules as a named skill. */
export const createSkillRequestSchema = z
  .object({
    name: z
      .string()
      .transform(cleanSkillName)
      .refine((s) => chars(s) >= 1, { message: "is empty" })
      .refine((s) => chars(s) <= SKILL_NAME_MAX_CHARS, {
        message: `at most ${SKILL_NAME_MAX_CHARS} characters`,
      }),
    source: z.union([
      z.object({ brief_id: z.string().min(1).max(64) }).strict(),
      z.object({ playbook_id: z.string().min(1).max(64) }).strict(),
    ]),
  })
  .strict();
export type CreateSkillRequest = z.infer<typeof createSkillRequestSchema>;

/**
 * PRD `videos[].group`. Uploads under 7 days old are listed as `other` with a null outlier score
 * (the window's `too_new` counts them); long uploads aren't listed (MIXED_FORMATS warns).
 */
export type PlaybookVideoGroup = "outlier" | "typical" | "other";

export interface PlaybookResponse {
  id: string;
  status: BriefStatus;
  stage: PlaybookStage | null;
  /** While watching: picked videos analyzed so far. */
  progress: { done: number; total: number } | null;
  channel: {
    id: string;
    title: string;
    handle: string | null;
    subscriber_count_rounded: number | null;
    subscriber_count_hidden: boolean;
  } | null;
  window: {
    from: string;
    to: string;
    uploads_seen: number;
    shorts_eligible: number;
    too_new: number;
  } | null;
  baseline: { median_views: number; median_engagement_rate: number | null } | null;
  videos: {
    id: string;
    title: string;
    published_at: string;
    views: number;
    likes: number | null;
    comments: number | null;
    /** Match Cut's own calculation: views ÷ the channel's median. Null when not eligible. */
    outlier_score: number | null;
    group: PlaybookVideoGroup;
    /**
     * In the comparison. A picked breakout or typical video that couldn't be analyzed is false
     * (VIDEOS_SKIPPED), so the app doesn't count it among the evidence.
     */
    compared: boolean;
    /** The pass 1 brief behind a compared video's breakdown, when one was saved. */
    brief_id: string | null;
  }[];
  /**
   * Set with NOT_ENOUGH_DATA (PRD: "with the reasons, how many were found and a suggestion"; the
   * suggestion is in the error message). Null otherwise.
   */
  not_enough_data: {
    reasons: NotEnoughDataReason[];
    found: { shorts_eligible: number; outliers: number; typical: number };
    minimums: { shorts_eligible: number; outliers: number; typical: number };
  } | null;
  rules: PlaybookRule[] | null;
  house_style: string | null;
  not_explained: string[] | null;
  recipe_prompt_template: string | null;
  warnings: { code: string; message: string }[];
  error: { code: string; message: string; retryable: boolean } | null;
  meta: {
    versions: Record<string, string>;
    models: Record<string, string>;
    cached: boolean;
    timings_ms: Record<string, number>;
    tokens: Record<string, number>;
    cost_usd: number | null;
    created_at: string;
  };
}

/**
 * A skill's saved recipe: everything apply needs, so it works after caches and sources expire.
 * `generated_at` is when the source was made, so the app can say how old the rules are.
 */
export type SkillSnapshotResponse =
  | {
      type: "brief";
      generated_at: string;
      video_id: string;
      video_title: string | null;
      breakdown: Breakdown;
    }
  | {
      type: "playbook";
      generated_at: string;
      channel: { id: string; title: string; handle: string | null };
      /** The settings the playbook used; "Refresh from channel" reuses them. */
      settings: { window_days: number; max_videos: number; outlier_threshold: number };
      window: { from: string; to: string } | null;
      rules: PlaybookRule[];
      house_style: string;
      not_explained: string[];
      recipe_prompt_template: string | null;
      /** The playbook's caveats (small sample, shared topic...), kept with its rules. */
      warnings: { code: string; message: string }[];
    };

/** In GET /v1/skills: what the skills list shows (name, source, last used). */
export interface SkillSummaryResponse {
  id: string;
  name: string;
  source: {
    type: "brief" | "playbook";
    id: string;
    /** The reference video's or channel's title. */
    title: string | null;
  };
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** GET /v1/skills/{id} and POST /v1/skills: the summary plus the snapshot and versions. */
export interface SkillResponse extends SkillSummaryResponse {
  snapshot: SkillSnapshotResponse;
  /** Prompt, schema and playbook versions at save time. */
  versions: Record<string, string>;
}
