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

/** PRD-playbooks.md, Cost, limits and caching: features 30 days, playbooks 24 hours. */
export const FEATURES_TTL_SECONDS = 30 * 24 * 3600;
export const PLAYBOOK_TTL_SECONDS = 24 * 3600;

/** Features of one breakdown: the pass 1 key plus the feature list's version and the model. */
export function featuresCacheKey(pass1Key: string, p: { model: string; version: string }): string {
  return `feat:${p.version}:${p.model}:${pass1Key}`;
}

/**
 * The running playbook for one user, channel and settings, so a double click starts one job.
 * Set by the API when it starts the job; released by the worker when the job ends.
 */
export function playbookInflightKey(
  userId: string,
  channelId: string,
  s: { windowDays: number; maxVideos: number; outlierThreshold: number },
): string {
  return `pbinflight:${userId}:${channelId}:${s.windowDays}:${s.maxVideos}:${s.outlierThreshold}`;
}

/** Releases a playbook's in-flight key, only while it still names that playbook. */
export async function releasePlaybookInflight(
  kv: { get(key: string): Promise<string | null>; del(key: string): Promise<void> },
  pb: {
    id: string;
    userId: string;
    channel: { id: string } | null;
    settings: { windowDays: number; maxVideos: number; outlierThreshold: number };
  },
): Promise<void> {
  if (!pb.channel) return;
  const key = playbookInflightKey(pb.userId, pb.channel.id, pb.settings);
  if ((await kv.get(key)) === pb.id) await kv.del(key);
}

/**
 * A finished playbook for a channel and settings, shared across users for 24 hours: the channel
 * stats key's parts plus the threshold, every version behind the result, and the models.
 */
export function playbookCacheKey(p: {
  channelId: string;
  windowDays: number;
  maxVideos: number;
  outlierThreshold: number;
  versions: Record<string, string>;
  models: Record<string, string>;
}): string {
  const sorted = (o: Record<string, string>) =>
    Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1));
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        p.channelId,
        p.windowDays,
        p.maxVideos,
        p.outlierThreshold,
        sorted(p.versions),
        sorted(p.models),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `pb:${hash}`;
}
