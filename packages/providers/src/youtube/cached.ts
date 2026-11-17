/**
 * PRD cache layer "Precheck metadata: key video ID, TTL 6 h, invalidated by TTL only".
 * Only found videos are cached: a not-found or unavailable answer is re-checked next time.
 * The pipeline re-classifies with the uncached lookup, so a video made private mid-job is seen.
 */
import type { VideoMetadata } from "@match-cut/core";
import type { LookupResult, VideoLookup } from "./types.js";

export const PRECHECK_TTL_SECONDS = 6 * 3600;

/** The slice of the KV store this needs (structurally compatible with @match-cut/infra KV). */
export interface SimpleCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export class CachedVideoLookup implements VideoLookup {
  constructor(
    private readonly inner: VideoLookup,
    private readonly cache: SimpleCache,
    private readonly ttlSeconds = PRECHECK_TTL_SECONDS,
  ) {}

  async lookup(videoId: string): Promise<LookupResult> {
    const key = `precheck:${videoId}`;
    const hit = await this.cache.get(key);
    if (hit) return { status: "found", video: JSON.parse(hit) as VideoMetadata };
    const result = await this.inner.lookup(videoId);
    if (result.status === "found") {
      await this.cache.set(key, JSON.stringify(result.video), this.ttlSeconds);
    }
    return result;
  }
}
