import { isVideoId, parseIsoDuration, type VideoMetadata } from "@match-cut/core";
import type { LookupResult, VideoLookup } from "./types.js";

const ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";

interface ApiThumbnail {
  url?: string;
}
interface ApiVideo {
  id: string;
  snippet?: {
    title?: string;
    channelTitle?: string;
    liveBroadcastContent?: string;
    thumbnails?: Record<string, ApiThumbnail | undefined>;
  };
  contentDetails?: {
    duration?: string;
    regionRestriction?: { allowed?: string[]; blocked?: string[] };
    contentRating?: { ytRating?: string };
  };
  status?: { privacyStatus?: string; embeddable?: boolean };
}

export interface YouTubeDataApiOptions {
  apiKey: string;
  /** PRD: treat the Data API as down after 2 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Maps a Data API `videos` item to our metadata. Exported for tests. */
export function toVideoMetadata(item: ApiVideo): VideoMetadata {
  const thumbs = item.snippet?.thumbnails ?? {};
  const thumbnailUrl =
    ["maxres", "standard", "high", "medium", "default"]
      .map((k) => thumbs[k]?.url)
      .find((u): u is string => typeof u === "string") ?? null;
  const privacy = item.status?.privacyStatus;
  const live = item.snippet?.liveBroadcastContent;
  return {
    id: item.id,
    title: item.snippet?.title ?? "",
    channel: item.snippet?.channelTitle ?? "",
    thumbnailUrl,
    durationSeconds: parseIsoDuration(item.contentDetails?.duration ?? "") ?? 0,
    // Unknown privacy values are treated as not public: safer to refuse than to analyze.
    privacyStatus: privacy === "public" || privacy === "unlisted" ? privacy : "private",
    embeddable: item.status?.embeddable !== false,
    ageRestricted: item.contentDetails?.contentRating?.ytRating === "ytAgeRestricted",
    regionRestriction: item.contentDetails?.regionRestriction ?? null,
    liveBroadcastContent: live === "live" || live === "upcoming" ? live : "none",
  };
}

export class YouTubeDataApiLookup implements VideoLookup {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;

  constructor(opts: YouTubeDataApiOptions) {
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async lookup(videoId: string): Promise<LookupResult> {
    if (!isVideoId(videoId)) throw new Error("lookup() needs a validated video ID");
    const url = new URL(ENDPOINT);
    url.searchParams.set("part", "snippet,contentDetails,status");
    url.searchParams.set("id", videoId);
    let res: Response;
    try {
      res = await this.fetch(url, {
        // Key in a header, not the query string, so it never lands in URL logs.
        headers: { "x-goog-api-key": this.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const name = (e as Error).name;
      return { status: "unavailable", reason: name === "TimeoutError" ? "timeout" : "network" };
    }
    if (!res.ok) {
      // 403 quotaExceeded, 5xx, or a bad key: all mean "skip the precheck".
      return { status: "unavailable", reason: `http_${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as { items?: ApiVideo[] } | null;
    if (!body) return { status: "unavailable", reason: "bad_json" };
    const item = body.items?.[0];
    if (!item) return { status: "not_found" };
    return { status: "found", video: toVideoMetadata(item) };
  }
}
