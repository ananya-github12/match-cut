/**
 * API and model-output schemas. PRD: "Backend: API contract" and
 * "Backend: Gemini integration > Breakdown schema (pass 1)".
 */
import { z } from "zod";

export const TARGET_FORMATS = ["9:16", "16:9", "1:1", "4:5", "match"] as const;
export const DETAIL_LEVELS = ["standard", "deep"] as const;
export const BRIEF_STATUSES = [
  "queued",
  "processing",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
] as const;
export const BRIEF_STAGES = ["prechecking", "watching", "writing_prompt", "validating"] as const;
export const TERMINAL_STATUSES = ["succeeded", "partial", "failed", "cancelled"] as const;

export type TargetFormat = (typeof TARGET_FORMATS)[number];
export type Detail = (typeof DETAIL_LEVELS)[number];
export type BriefStatus = (typeof BRIEF_STATUSES)[number];
export type BriefStage = (typeof BRIEF_STAGES)[number];

export function isTerminal(status: BriefStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export const GOAL_MAX_CHARS = 1500;
// BCP-47 shape check (language, optional script/region/variants), e.g. "en", "hi", "pt-BR", "zh-Hant-TW".
export const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// ---------- Requests ----------

export const createBriefRequestSchema = z
  .object({
    source: z.object({ url: z.string() }).strict(),
    goal: z.string().optional(),
    target: z
      .object({
        format: z.enum(TARGET_FORMATS).default("match"),
        length_seconds: z.number().int().min(5).max(600).optional(),
      })
      .strict()
      .default({}),
    clip: z
      .object({
        start_seconds: z.number().optional(),
        end_seconds: z.number().optional(),
      })
      .strict()
      .optional(),
    output_language: z.string().regex(BCP47).default("en"),
    detail: z.enum(DETAIL_LEVELS).default("standard"),
    force_refresh: z.boolean().default(false),
  })
  .strict();
export type CreateBriefRequest = z.infer<typeof createBriefRequestSchema>;

export const regenerateRequestSchema = z
  .object({
    goal: z.string().optional(),
    target: z
      .object({
        format: z.enum(TARGET_FORMATS).optional(),
        // null clears a previous target length ("match the reference").
        length_seconds: z.number().int().min(5).max(600).nullable().optional(),
      })
      .strict()
      .optional(),
    output_language: z.string().regex(BCP47).optional(),
  })
  .strict();
export type RegenerateRequest = z.infer<typeof regenerateRequestSchema>;

// ---------- Pass 1: breakdown ----------

const mmss = z.string().regex(/^\d{2,3}:[0-5]\d$/, "mm:ss");

export const beatSchema = z.object({
  start: mmss,
  end: mmss,
  label: z.string().min(1),
  what_happens: z.string().min(1),
});

export const breakdownSchema = z.object({
  summary: z.string().min(1),
  video_type: z.string().min(1),
  format: z.object({
    aspect_ratio: z.enum(["9:16", "16:9", "1:1", "4:5", "other"]),
    duration: mmss,
    avg_shot_length_seconds: z.number().min(0.2).max(120),
  }),
  hook: z.string().min(1),
  beats: z.array(beatSchema).min(2).max(15),
  style: z.object({
    pacing: z.string().min(1),
    framing: z.string().min(1),
    transitions: z.string().min(1),
    text_and_graphics: z.string().min(1),
    audio: z.string().min(1),
    delivery: z.string().min(1),
    look: z.string().min(1),
  }),
  signals: z.object({
    has_speech: z.boolean(),
    has_on_camera_person: z.boolean(),
    has_music: z.boolean(),
    has_on_screen_text: z.boolean(),
  }),
});
export type Breakdown = z.infer<typeof breakdownSchema>;

/** Pass 1 model output: the breakdown plus internal-only spoken lines (never returned by the API). */
export const pass1OutputSchema = breakdownSchema.extend({
  spoken_lines_internal: z.array(z.string()).max(10),
});
export type Pass1Output = z.infer<typeof pass1OutputSchema>;

// ---------- Pass 2: prompt ----------

/** One shot the user should film. PRD-playbooks.md, Feature 2. */
export const shotSchema = z.object({
  shot: z.string().min(1).max(300),
  framing: z.string().min(1).max(200),
  duration_seconds: z.number().positive().max(120),
  /** Reference beat it recreates, 1 = first beat of the breakdown. */
  maps_to_beat: z.number().int().min(1),
  notes: z.string().max(300).default(""),
});
export type Shot = z.infer<typeof shotSchema>;
export const SHOT_LIST_MIN = 4;
export const SHOT_LIST_MAX = 15;

/** The prompt part of pass 2. A problem here fails the brief. */
export const pass2CoreSchema = z.object({
  cardboard_prompt: z.string().min(1),
  assets_needed: z.array(z.string().min(1)).max(8),
  watch_outs: z.array(z.string().min(1)).min(1).max(8),
});

/**
 * Pass 2 output as stored and cached. The shot list is checked on its own: if it can't be fixed,
 * the brief keeps its prompt and gets an empty list plus a SHOT_LIST_UNAVAILABLE warning.
 */
export const pass2OutputSchema = pass2CoreSchema.extend({
  shot_list: z.array(shotSchema).max(SHOT_LIST_MAX).default([]),
});
export type Pass2Output = z.infer<typeof pass2OutputSchema>;

// ---------- Response: brief object ----------

export interface AnalyzedRangeOut {
  start_seconds: number;
  end_seconds: number;
}

export interface BriefResponse {
  id: string;
  status: BriefStatus;
  stage: BriefStage | null;
  video: {
    id: string;
    title: string | null;
    channel: string | null;
    duration_seconds: number | null;
    aspect_ratio: string | null;
    analyzed_range: AnalyzedRangeOut | null;
  };
  breakdown: Breakdown | null;
  cardboard_prompt: string | null;
  assets_needed: string[] | null;
  watch_outs: string[] | null;
  /** What to film; null before the prompt exists or for briefs made before shot lists. */
  shot_list: Shot[] | null;
  warnings: { code: string; message: string }[];
  error: { code: string; message: string; retryable: boolean } | null;
  meta: {
    model: string | null;
    prompt_version: string;
    schema_version: string;
    cached: boolean;
    timings_ms: Record<string, number>;
    tokens: Record<string, number>;
    created_at: string;
  };
}
