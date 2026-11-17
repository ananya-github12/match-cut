/** Cache keys. PRD: "Backend: performance, cost, caching and limits > Caching". Server-only. */
import { createHash } from "node:crypto";
import type { AnalyzedRange } from "./video.js";
import type { Detail, TargetFormat } from "./schemas.js";

export const PASS1_TTL_SECONDS = 30 * 24 * 3600;
export const PASS2_TTL_SECONDS = 7 * 24 * 3600;

export function pass1CacheKey(p: {
  videoId: string;
  range: AnalyzedRange | null;
  detail: Detail;
  model: string;
  promptVersion: string;
}): string {
  const range = p.range ? `${p.range.start_seconds}-${p.range.end_seconds}` : "full";
  return `p1:${p.videoId}:${range}:${p.detail}:${p.model}:${p.promptVersion}`;
}

export function pass2CacheKey(
  pass1Key: string,
  p: {
    goal: string;
    format: TargetFormat;
    lengthSeconds: number | null;
    language: string;
    model: string;
    promptVersion: string;
    manifestVersion: string;
  },
): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        pass1Key,
        p.goal,
        p.format,
        p.lengthSeconds,
        p.language,
        p.model,
        p.promptVersion,
        p.manifestVersion,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `p2:${hash}`;
}
