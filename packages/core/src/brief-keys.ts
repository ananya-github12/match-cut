/** Cache and coordination keys for one brief, shared by the API and the worker. Server-only. */
import { pass1CacheKey, pass2CacheKey } from "./cache-keys.js";
import type { ModelNames } from "./env.js";
import type { Detail, TargetFormat } from "./schemas.js";
import { PASS1_PROMPT_VERSION, PASS2_PROMPT_VERSION } from "./versions.js";
import type { AnalyzedRange } from "./video.js";

export interface BriefKeyInput {
  userId: string;
  videoId: string;
  range: AnalyzedRange | null;
  detail: Detail;
  goal: string;
  targetFormat: TargetFormat;
  targetLengthSeconds: number | null;
  outputLanguage: string;
}

export function briefKeys(b: BriefKeyInput, models: ModelNames, manifestVersion: string) {
  const pass1 = pass1CacheKey({
    videoId: b.videoId,
    range: b.range,
    detail: b.detail,
    model: b.detail === "deep" ? models.deep : models.standard,
    promptVersion: PASS1_PROMPT_VERSION,
  });
  const pass2 = pass2CacheKey(pass1, {
    goal: b.goal,
    format: b.targetFormat,
    lengthSeconds: b.targetLengthSeconds,
    language: b.outputLanguage,
    model: models.pass2,
    promptVersion: PASS2_PROMPT_VERSION,
    manifestVersion,
  });
  return {
    pass1,
    pass2,
    /** Same user, same full request, still running: attach instead of starting again. */
    inflight: `inflight:${b.userId}:${pass2}`,
  };
}

/** How long an in-flight marker lives if a worker dies without clearing it. */
export const INFLIGHT_TTL_SECONDS = 10 * 60;
