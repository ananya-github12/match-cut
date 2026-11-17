import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  url: z.string().nullable(),
  clip: z.object({ start_seconds: z.number(), end_seconds: z.number() }).nullable().optional(),
  category: z.string(),
  goal: z.string(),
  target: z.object({
    format: z.enum(["9:16", "16:9", "1:1", "4:5", "match"]),
    length_seconds: z.number().int().nullable(),
  }),
  language: z.string().default("en"),
  detail: z.enum(["standard", "deep"]).default("standard"),
  status: z.enum(["ready", "needs_reference", "needs_video"]),
});
export type EvalCase = z.infer<typeof caseSchema>;

export const setSchema = z.object({ target_size: z.number(), cases: z.array(caseSchema) });

export const referenceSchema = z.object({
  written_by: z.string(),
  written_at: z.string(),
  facts: z.array(z.string().min(1)).min(1),
  has_speech: z.boolean().optional(),
  has_music: z.boolean().optional(),
  has_on_camera_person: z.boolean().optional(),
  aspect_ratio: z.string().optional(),
  brand_terms: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type Reference = z.infer<typeof referenceSchema>;

export interface LoadedCase {
  case: EvalCase;
  reference: Reference | null;
  /** Why the case won't run, if it won't. */
  skip?: string;
}

export function loadSet(dir: string): { targetSize: number; cases: LoadedCase[] } {
  const set = setSchema.parse(JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")));
  const cases = set.cases.map((c): LoadedCase => {
    if (c.status === "needs_video" || !c.url)
      return { case: c, reference: null, skip: "no video yet" };
    let reference: Reference | null = null;
    try {
      reference = referenceSchema.parse(
        JSON.parse(readFileSync(join(dir, "references", `${c.id}.json`), "utf8")),
      );
    } catch {
      reference = null;
    }
    if (!reference || !reference.written_by || !reference.written_at) {
      return { case: c, reference: null, skip: "needs a human-written reference" };
    }
    return { case: c, reference };
  });
  return { targetSize: set.target_size, cases };
}

export type CriterionName =
  "accuracy" | "specificity" | "executability" | "adaptation" | "originality" | "honesty";

export interface CriterionResult {
  pass: boolean | null; // null: not scored for this case
  value?: number;
  detail?: string;
}

export interface CaseResult {
  id: string;
  category: string;
  status: "scored" | "skipped" | "error";
  skip?: string;
  error?: string;
  criteria?: Record<CriterionName, CriterionResult>;
  accuracyCounts?: { consistent: number; contradicted: number; unverifiable: number };
  breakdown?: unknown;
  prompt?: string;
  models?: { pass1: string; pass2: string };
  repairs?: { pass1: boolean; pass2: boolean };
  tokens?: Record<string, number>;
  costUsd?: number;
  seconds?: number;
  judgeNotes?: string[];
}
