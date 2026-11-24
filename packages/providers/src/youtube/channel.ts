/**
 * Channel data for playbooks. PRD-playbooks.md, Feature 3 > "Data from the YouTube Data API".
 * Public data only, no user sign-in: channel, recent uploads, and each upload's public stats.
 * Never calls search.list (100 quota units); a playbook costs about 3 to 5 units.
 *
 * Titles are channel-owner text: capped here and always treated as data, never instructions.
 */
import { isChannelId, isVideoId, parseIsoDuration, type ChannelRef } from "@match-cut/core";

export interface ChannelInfo {
  id: string;
  title: string;
  /** Without the @, or null if the channel has none. */
  handle: string | null;
  /** Rounded down to 3 significant figures by YouTube; null when hidden. */
  subscriberCount: number | null;
  subscriberCountHidden: boolean;
  /** The channel's "uploads" playlist. */
  uploadsPlaylistId: string;
  thumbnailUrl: string | null;
}

export interface ChannelVideo {
  id: string;
  title: string;
  /** ISO 8601. */
  publishedAt: string;
  durationSeconds: number;
  views: number;
  /** null when the creator hides likes. */
  likes: number | null;
  /** null when comments are off. */
  comments: number | null;
  liveBroadcastContent: "none" | "live" | "upcoming";
}

/** Why the Data API couldn't answer. `quota` maps to CAPACITY_EXHAUSTED. */
export type UnavailableReason =
  "quota" | "timeout" | "network" | "bad_json" | "mock" | `http_${number}`;

export type ChannelResult =
  | { status: "found"; channel: ChannelInfo }
  | { status: "not_found" }
  | { status: "unavailable"; reason: UnavailableReason };

export type UploadsResult =
  { status: "ok"; videos: ChannelVideo[] } | { status: "unavailable"; reason: UnavailableReason };

export interface UploadsQuery {
  /** At most this many uploads, newest first (PRD: 10 to 50). */
  maxVideos: number;
  /** Only uploads from the last this-many days (PRD: 30 to 180). */
  windowDays: number;
}

export interface LookupOptions {
  /** Skip cached answers and fetch again (PRD: force_refresh refetches stats). */
  refresh?: boolean;
}

export interface ChannelLookup {
  resolve(ref: ChannelRef, opts?: LookupOptions): Promise<ChannelResult>;
  recentUploads(
    channel: ChannelInfo,
    query: UploadsQuery,
    opts?: LookupOptions,
  ): Promise<UploadsResult>;
}

const API = "https://www.googleapis.com/youtube/v3";
const PAGE = 50;
/** Max characters kept from titles (owner-controlled text). */
export const MAX_TITLE_CHARS = 200;
/**
 * The uploads playlist is ordered by when items were added, not strictly by publish date, so a
 * single old item doesn't end the walk: stop after this many in a row fall outside the window.
 */
const OUT_OF_WINDOW_RUN = 3;

interface ApiChannel {
  id: string;
  snippet?: {
    title?: string;
    customUrl?: string;
    thumbnails?: Record<string, { url?: string } | undefined>;
  };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
}
interface ApiPlaylistItem {
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
}
interface ApiVideo {
  id: string;
  snippet?: { title?: string; publishedAt?: string; liveBroadcastContent?: string };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

const num = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const title = (t: string | undefined) =>
  (t ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);

/** Maps a Data API `channels` item. Exported for tests. */
export function toChannelInfo(item: ApiChannel): ChannelInfo | null {
  const uploads = item.contentDetails?.relatedPlaylists?.uploads;
  if (!isChannelId(item.id) || !uploads) return null;
  const thumbs = item.snippet?.thumbnails ?? {};
  const custom = item.snippet?.customUrl;
  const hidden = item.statistics?.hiddenSubscriberCount === true;
  return {
    id: item.id,
    title: title(item.snippet?.title),
    handle: custom?.startsWith("@") ? custom.slice(1) : null,
    subscriberCount: hidden ? null : num(item.statistics?.subscriberCount),
    subscriberCountHidden: hidden,
    uploadsPlaylistId: uploads,
    thumbnailUrl:
      ["high", "medium", "default"]
        .map((k) => thumbs[k]?.url)
        .find((u): u is string => typeof u === "string") ?? null,
  };
}

/**
 * Maps a Data API `videos` item. Returns null when the facts scoring depends on are missing
 * (duration, publish date or view count): such a video must not look like a fresh 0-second
 * Short with 0 views. Exported for tests.
 */
export function toChannelVideo(item: ApiVideo): ChannelVideo | null {
  if (!isVideoId(item.id)) return null;
  const duration = parseIsoDuration(item.contentDetails?.duration ?? "");
  const published = Date.parse(item.snippet?.publishedAt ?? "");
  const views = num(item.statistics?.viewCount);
  if (duration === null || duration <= 0 || !Number.isFinite(published) || views === null) {
    return null;
  }
  const live = item.snippet?.liveBroadcastContent;
  return {
    id: item.id,
    title: title(item.snippet?.title),
    publishedAt: new Date(published).toISOString(),
    durationSeconds: duration,
    views,
    likes: num(item.statistics?.likeCount),
    comments: num(item.statistics?.commentCount),
    liveBroadcastContent: live === "live" || live === "upcoming" ? live : "none",
  };
}

export interface YouTubeChannelApiOptions {
  apiKey: string;
  /** Playbooks aren't latency-critical; allow more than the 2 s precheck. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

type Fetched =
  { ok: true; body: unknown } | { ok: false; status: number; reason: UnavailableReason };

const QUOTA_REASON = /quota|ratelimit|dailylimit/i;

function abortReason(e: unknown): UnavailableReason | null {
  const name = (e as Error | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : null;
}

export class YouTubeDataApiChannelLookup implements ChannelLookup {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;

  constructor(opts: YouTubeChannelApiOptions) {
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
  }

  private async get(path: string, params: Record<string, string>): Promise<Fetched> {
    const url = new URL(`${API}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetch(url, {
        // Key in a header, not the query string, so it never lands in URL logs.
        headers: { "x-goog-api-key": this.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      return { ok: false, status: 0, reason: abortReason(e) ?? "network" };
    }
    type Body = { error?: { errors?: { reason?: string }[] } };
    let body: Body | null = null;
    try {
      body = (await res.json()) as Body | null;
    } catch (e) {
      // The timeout can fire while the body is still arriving.
      const timedOut = abortReason(e);
      if (timedOut) return { ok: false, status: res.status, reason: timedOut };
    }
    if (!res.ok) {
      const reasons = body?.error?.errors?.map((e) => e.reason ?? "") ?? [];
      const quota = res.status === 429 || reasons.some((r) => QUOTA_REASON.test(r));
      return {
        ok: false,
        status: res.status,
        reason: quota ? "quota" : (`http_${res.status}` as const),
      };
    }
    if (!body) return { ok: false, status: res.status, reason: "bad_json" };
    return { ok: true, body };
  }

  async resolve(ref: ChannelRef): Promise<ChannelResult> {
    const params: Record<string, string> = { part: "snippet,contentDetails,statistics" };
    switch (ref.kind) {
      case "handle":
        params.forHandle = `@${ref.handle}`;
        break;
      case "id":
        if (!isChannelId(ref.channelId)) return { status: "not_found" };
        params.id = ref.channelId;
        break;
      case "username":
        params.forUsername = ref.username;
        break;
      case "video": {
        if (!isVideoId(ref.videoId)) return { status: "not_found" };
        const v = await this.get("videos", { part: "snippet", id: ref.videoId });
        if (!v.ok) return { status: "unavailable", reason: v.reason };
        const channelId = (v.body as { items?: { snippet?: { channelId?: string } }[] }).items?.[0]
          ?.snippet?.channelId;
        if (!channelId || !isChannelId(channelId)) return { status: "not_found" };
        params.id = channelId;
        break;
      }
    }
    const res = await this.get("channels", params);
    if (!res.ok) {
      return res.status === 404
        ? { status: "not_found" }
        : { status: "unavailable", reason: res.reason };
    }
    const item = (res.body as { items?: ApiChannel[] }).items?.[0];
    const channel = item ? toChannelInfo(item) : null;
    return channel ? { status: "found", channel } : { status: "not_found" };
  }

  async recentUploads(channel: ChannelInfo, query: UploadsQuery): Promise<UploadsResult> {
    if (query.maxVideos <= 0) return { status: "ok", videos: [] };
    const since = this.now().getTime() - query.windowDays * 86_400_000;
    const ids: string[] = [];
    let pageToken: string | undefined;
    let outOfWindow = 0;
    let done = false;
    // One page per 50 videos, plus one in case out-of-order items need a few more.
    for (let page = 0; page <= Math.ceil(query.maxVideos / PAGE) && !done; page++) {
      const params: Record<string, string> = {
        part: "contentDetails",
        playlistId: channel.uploadsPlaylistId,
        maxResults: String(PAGE),
      };
      if (pageToken) params.pageToken = pageToken;
      const res = await this.get("playlistItems", params);
      if (!res.ok) {
        // A channel with no uploads has no uploads playlist.
        if (res.status === 404) return { status: "ok", videos: [] };
        return { status: "unavailable", reason: res.reason };
      }
      const body = res.body as { items?: ApiPlaylistItem[]; nextPageToken?: string };
      for (const item of body.items ?? []) {
        const id = item.contentDetails?.videoId;
        if (!id || !isVideoId(id) || ids.includes(id)) continue;
        const at = Date.parse(item.contentDetails?.videoPublishedAt ?? "");
        if (Number.isFinite(at) && at < since) {
          if (++outOfWindow >= OUT_OF_WINDOW_RUN) {
            done = true;
            break;
          }
          continue;
        }
        outOfWindow = 0;
        ids.push(id);
        if (ids.length >= query.maxVideos) {
          done = true;
          break;
        }
      }
      pageToken = body.nextPageToken;
      if (!pageToken) break;
    }
    const videos: ChannelVideo[] = [];
    for (let i = 0; i < ids.length; i += PAGE) {
      const res = await this.get("videos", {
        part: "snippet,contentDetails,statistics",
        id: ids.slice(i, i + PAGE).join(","),
      });
      if (!res.ok) return { status: "unavailable", reason: res.reason };
      for (const item of (res.body as { items?: ApiVideo[] }).items ?? []) {
        const v = toChannelVideo(item);
        // Incomplete items, scheduled premieres and live streams aren't comparable uploads.
        // The window is checked again on the video's own publish date.
        if (v && v.liveBroadcastContent === "none" && Date.parse(v.publishedAt) >= since) {
          videos.push(v);
        }
      }
    }
    // Newest first.
    videos.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    return { status: "ok", videos };
  }
}

/** Cache: resolved channels and upload stats for 24 h (PRD cache table). */
export const CHANNEL_CACHE_TTL_SECONDS = 24 * 3600;
/** A handle that wasn't found is remembered briefly, so retries don't spend quota. */
export const CHANNEL_NOT_FOUND_TTL_SECONDS = 600;
/** Bump when ChannelInfo or ChannelVideo change shape, so old entries stop matching. */
export const CHANNEL_CACHE_VERSION = "v1";
const NOT_FOUND = "__not_found__";

export interface ChannelCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

function refKey(ref: ChannelRef): string {
  switch (ref.kind) {
    case "handle":
      return `h:${ref.handle.toLowerCase()}`;
    case "id":
      return `i:${ref.channelId}`;
    case "username":
      return `u:${ref.username.toLowerCase()}`;
    case "video":
      return `v:${ref.videoId}`;
  }
}

/** Any cache problem (Redis down, corrupt entry) counts as a miss, never a failure. */
export class CachedChannelLookup implements ChannelLookup {
  constructor(
    private readonly inner: ChannelLookup,
    private readonly cache: ChannelCache,
    private readonly ttlSeconds = CHANNEL_CACHE_TTL_SECONDS,
  ) {}

  private async read<T>(key: string): Promise<T | typeof NOT_FOUND | null> {
    try {
      const hit = await this.cache.get(key);
      if (hit === null) return null;
      if (hit === NOT_FOUND) return NOT_FOUND;
      return JSON.parse(hit) as T;
    } catch {
      return null;
    }
  }

  private async write(key: string, value: string, ttl: number): Promise<void> {
    try {
      await this.cache.set(key, value, ttl);
    } catch {
      // Caching is best effort.
    }
  }

  async resolve(ref: ChannelRef, opts: LookupOptions = {}): Promise<ChannelResult> {
    const key = `channel:${CHANNEL_CACHE_VERSION}:${refKey(ref)}`;
    if (!opts.refresh) {
      const hit = await this.read<ChannelInfo>(key);
      if (hit === NOT_FOUND) return { status: "not_found" };
      if (hit && typeof hit === "object" && isChannelId(hit.id)) {
        return { status: "found", channel: hit };
      }
    }
    const result = await this.inner.resolve(ref, opts);
    if (result.status === "found") {
      await this.write(key, JSON.stringify(result.channel), this.ttlSeconds);
    } else if (result.status === "not_found") {
      await this.write(key, NOT_FOUND, CHANNEL_NOT_FOUND_TTL_SECONDS);
    }
    return result;
  }

  async recentUploads(
    channel: ChannelInfo,
    query: UploadsQuery,
    opts: LookupOptions = {},
  ): Promise<UploadsResult> {
    const key = `chstats:${CHANNEL_CACHE_VERSION}:${channel.id}:${query.windowDays}:${query.maxVideos}`;
    if (!opts.refresh) {
      const hit = await this.read<ChannelVideo[]>(key);
      if (Array.isArray(hit)) return { status: "ok", videos: hit };
    }
    const result = await this.inner.recentUploads(channel, query, opts);
    if (result.status === "ok") {
      await this.write(key, JSON.stringify(result.videos), this.ttlSeconds);
    }
    return result;
  }
}
