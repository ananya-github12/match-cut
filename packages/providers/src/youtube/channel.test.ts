import { describe, expect, it, vi } from "vitest";
import {
  CachedChannelLookup,
  toChannelInfo,
  toChannelVideo,
  YouTubeDataApiChannelLookup,
  type ChannelInfo,
} from "./channel.js";
import {
  GOLDEN_CHANNEL_HANDLES,
  MOCK_CHANNEL_NOT_FOUND,
  MOCK_CHANNEL_UNAVAILABLE,
  MockChannelLookup,
  mockChannelId,
} from "./mock-channels.js";

const CH = "UCaBcDeFgHiJkLmNoPqRsTuV";
const NOW = new Date("2026-11-24T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const apiChannel = {
  id: CH,
  snippet: {
    title: "Creator",
    customUrl: "@creator",
    thumbnails: { default: { url: "https://yt3/d.jpg" }, high: { url: "https://yt3/h.jpg" } },
  },
  contentDetails: { relatedPlaylists: { uploads: "UUaBcDeFgHiJkLmNoPqRsTuV" } },
  statistics: { subscriberCount: "1230000", hiddenSubscriberCount: false },
};

const vid = (i: number) => `vid${String(i).padStart(8, "0")}`; // 11 characters

function apiVideo(i: number, over: Record<string, unknown> = {}) {
  return {
    id: vid(i),
    snippet: { title: `Video ${i}`, publishedAt: daysAgo(i + 1), liveBroadcastContent: "none" },
    contentDetails: { duration: "PT45S" },
    statistics: { viewCount: String(1000 * (i + 1)), likeCount: "50", commentCount: "3" },
    ...over,
  };
}

/** A fake fetch that answers by path and records every call. */
function fakeFetch(routes: Record<string, (url: URL) => { status?: number; body: unknown }>) {
  const calls: URL[] = [];
  const fn = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    expect(url.searchParams.has("key")).toBe(false);
    const name = url.pathname.split("/").pop()!;
    const route = routes[name];
    if (!route) throw new Error(`unexpected call ${url}`);
    const { status = 200, body } = route(url);
    return new Response(JSON.stringify(body), { status });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const api = (f: typeof fetch) =>
  new YouTubeDataApiChannelLookup({ apiKey: "k", fetch: f, now: () => NOW });

describe("mapping Data API items", () => {
  it("channel: handle, rounded subscribers, uploads playlist, best thumbnail", () => {
    expect(toChannelInfo(apiChannel)).toEqual({
      id: CH,
      title: "Creator",
      handle: "creator",
      subscriberCount: 1230000,
      subscriberCountHidden: false,
      uploadsPlaylistId: "UUaBcDeFgHiJkLmNoPqRsTuV",
      thumbnailUrl: "https://yt3/h.jpg",
    });
  });
  it("hidden subscribers become null; no uploads playlist means unusable", () => {
    const hidden = toChannelInfo({
      ...apiChannel,
      statistics: { subscriberCount: "0", hiddenSubscriberCount: true },
    });
    expect(hidden).toMatchObject({ subscriberCount: null, subscriberCountHidden: true });
    expect(toChannelInfo({ ...apiChannel, contentDetails: {} })).toBeNull();
    expect(toChannelInfo({ ...apiChannel, id: "nope" })).toBeNull();
  });
  it("video: hidden likes and disabled comments are null, not zero", () => {
    const v = toChannelVideo(apiVideo(0, { statistics: { viewCount: "12345" } }));
    expect(v).toMatchObject({ views: 12345, likes: null, comments: null, durationSeconds: 45 });
  });
  it("video: missing duration, publish date or views drops the item instead of faking it", () => {
    expect(toChannelVideo(apiVideo(0, { contentDetails: {} }))).toBeNull();
    expect(toChannelVideo(apiVideo(0, { contentDetails: { duration: "P0D" } }))).toBeNull();
    expect(
      toChannelVideo(apiVideo(0, { snippet: { title: "x", liveBroadcastContent: "none" } })),
    ).toBeNull();
    expect(toChannelVideo(apiVideo(0, { statistics: { likeCount: "5" } }))).toBeNull();
  });
  it("video: titles are collapsed and capped", () => {
    const long = toChannelVideo(
      apiVideo(0, {
        snippet: {
          title: `a\n\n${"b".repeat(400)}`,
          publishedAt: daysAgo(1),
          liveBroadcastContent: "none",
        },
      }),
    );
    expect(long!.title.startsWith("a b")).toBe(true);
    expect(long!.title.length).toBe(200);
  });
});

describe("YouTubeDataApiChannelLookup.resolve", () => {
  it("by handle, with the @ and only the parsed handle", async () => {
    const { fetch, calls } = fakeFetch({ channels: () => ({ body: { items: [apiChannel] } }) });
    const r = await api(fetch).resolve({ kind: "handle", handle: "creator" });
    expect(r).toMatchObject({ status: "found", channel: { id: CH } });
    expect(calls[0]!.searchParams.get("forHandle")).toBe("@creator");
    expect(calls[0]!.searchParams.get("part")).toBe("snippet,contentDetails,statistics");
  });
  it("by channel ID and by legacy username", async () => {
    const { fetch, calls } = fakeFetch({ channels: () => ({ body: { items: [apiChannel] } }) });
    await api(fetch).resolve({ kind: "id", channelId: CH });
    await api(fetch).resolve({ kind: "username", username: "GoogleDevelopers" });
    expect(calls[0]!.searchParams.get("id")).toBe(CH);
    expect(calls[1]!.searchParams.get("forUsername")).toBe("GoogleDevelopers");
  });
  it("by video: looks up the video's channel first", async () => {
    const { fetch, calls } = fakeFetch({
      videos: () => ({ body: { items: [{ snippet: { channelId: CH } }] } }),
      channels: () => ({ body: { items: [apiChannel] } }),
    });
    const r = await api(fetch).resolve({ kind: "video", videoId: "dQw4w9WgXcQ" });
    expect(r.status).toBe("found");
    expect(calls.map((c) => c.pathname.split("/").pop())).toEqual(["videos", "channels"]);
  });
  it("no items, an unknown video or a bad channel ID: not found", async () => {
    const { fetch } = fakeFetch({
      channels: () => ({ body: { items: [] } }),
      videos: () => ({ body: { items: [] } }),
    });
    expect((await api(fetch).resolve({ kind: "handle", handle: "nobody" })).status).toBe(
      "not_found",
    );
    expect((await api(fetch).resolve({ kind: "video", videoId: "dQw4w9WgXcQ" })).status).toBe(
      "not_found",
    );
    expect((await api(fetch).resolve({ kind: "id", channelId: "UCbad" })).status).toBe("not_found");
  });
  it("quota errors are 'quota'; other failures are unavailable", async () => {
    const quota = fakeFetch({
      channels: () => ({
        status: 403,
        body: { error: { errors: [{ reason: "quotaExceeded" }] } },
      }),
    });
    expect(await api(quota.fetch).resolve({ kind: "handle", handle: "x1x" })).toEqual({
      status: "unavailable",
      reason: "quota",
    });
    const down = fakeFetch({ channels: () => ({ status: 500, body: {} }) });
    expect(await api(down.fetch).resolve({ kind: "handle", handle: "x1x" })).toEqual({
      status: "unavailable",
      reason: "http_500",
    });
  });
});

describe("YouTubeDataApiChannelLookup.recentUploads", () => {
  const channel = toChannelInfo(apiChannel) as ChannelInfo;

  it("stops at the window start, then fetches stats for those videos in one call", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      contentDetails: { videoId: vid(i), videoPublishedAt: daysAgo(i * 5 + 1) },
    }));
    const { fetch, calls } = fakeFetch({
      playlistItems: () => ({ body: { items, nextPageToken: "next" } }),
      videos: (url) => ({
        body: {
          items: url.searchParams
            .get("id")!
            .split(",")
            .map((_, i) => apiVideo(i)),
        },
      }),
    });
    const r = await api(fetch).recentUploads(channel, { maxVideos: 50, windowDays: 90 });
    expect(r.status).toBe("ok");
    // Days 1, 6, ... 86 are inside 90 days: 18 videos; day 91 stops the walk.
    expect(calls.filter((c) => c.pathname.endsWith("playlistItems"))).toHaveLength(1);
    const videosCall = calls.find((c) => c.pathname.endsWith("/videos"))!;
    expect(videosCall.searchParams.get("id")!.split(",")).toHaveLength(18);
    expect(videosCall.searchParams.get("part")).toBe("snippet,contentDetails,statistics");
  });

  it("caps at maxVideos and pages when needed", async () => {
    let page = 0;
    const { fetch, calls } = fakeFetch({
      playlistItems: () => {
        const start = page++ * 50;
        return {
          body: {
            items: Array.from({ length: 50 }, (_, i) => ({
              contentDetails: { videoId: vid(start + i), videoPublishedAt: daysAgo(1) },
            })),
            nextPageToken: "more",
          },
        };
      },
      videos: (url) => ({
        body: {
          items: url.searchParams
            .get("id")!
            .split(",")
            .map((_, i) => apiVideo(i)),
        },
      }),
    });
    const r = await api(fetch).recentUploads(channel, { maxVideos: 50, windowDays: 90 });
    expect(r.status === "ok" && r.videos.length).toBe(50);
    expect(calls.filter((c) => c.pathname.endsWith("playlistItems"))).toHaveLength(1);
  });

  it("skips live and upcoming broadcasts; a missing uploads playlist means no uploads", async () => {
    const { fetch } = fakeFetch({
      playlistItems: () => ({
        body: {
          items: [0, 1].map((i) => ({
            contentDetails: { videoId: vid(i), videoPublishedAt: daysAgo(1) },
          })),
        },
      }),
      videos: () => ({
        body: {
          items: [
            apiVideo(0),
            apiVideo(1, {
              snippet: { title: "Live", publishedAt: daysAgo(1), liveBroadcastContent: "live" },
            }),
          ],
        },
      }),
    });
    const r = await api(fetch).recentUploads(channel, { maxVideos: 50, windowDays: 90 });
    expect(r.status === "ok" && r.videos.map((v) => v.id)).toEqual([vid(0)]);

    const empty = fakeFetch({ playlistItems: () => ({ status: 404, body: {} }) });
    expect(
      await api(empty.fetch).recentUploads(channel, { maxVideos: 50, windowDays: 90 }),
    ).toEqual({ status: "ok", videos: [] });
  });
});

describe("CachedChannelLookup", () => {
  it("caches found channels and upload stats for 24 h", async () => {
    const store = new Map<string, string>();
    const ttls: number[] = [];
    const cache = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string, ttl: number) => {
        store.set(k, v);
        ttls.push(ttl);
      },
    };
    const inner = new MockChannelLookup({ now: () => NOW });
    const spy = vi.spyOn(inner, "resolve");
    const lookup = new CachedChannelLookup(inner, cache);
    const a = await lookup.resolve({ kind: "handle", handle: "MockGolden01" });
    const b = await lookup.resolve({ kind: "handle", handle: "mockgolden01" });
    expect(a).toEqual(b);
    expect(spy).toHaveBeenCalledOnce();
    // Not-found is remembered briefly (CHANNEL_NOT_FOUND_TTL_SECONDS), so one more call only.
    await lookup.resolve({ kind: "handle", handle: MOCK_CHANNEL_NOT_FOUND });
    await lookup.resolve({ kind: "handle", handle: MOCK_CHANNEL_NOT_FOUND });
    expect(spy).toHaveBeenCalledTimes(2);
    if (a.status !== "found") throw new Error("expected found");
    const q = { maxVideos: 50, windowDays: 90 };
    const up1 = await lookup.recentUploads(a.channel, q);
    const up2 = await lookup.recentUploads(a.channel, q);
    expect(up1).toEqual(up2);
    // Found entries live 24 h; the not-found marker 10 minutes.
    expect([...new Set(ttls)].sort((x, y) => x - y)).toEqual([600, 24 * 3600]);
  });
});

describe("MockChannelLookup", () => {
  const lookup = new MockChannelLookup({ now: () => NOW });
  const q = { maxVideos: 50, windowDays: 90 };

  it("has 10 golden channels, each resolvable by handle, ID and one of its videos", async () => {
    expect(GOLDEN_CHANNEL_HANDLES).toHaveLength(10);
    for (const handle of GOLDEN_CHANNEL_HANDLES) {
      const r = await lookup.resolve({ kind: "handle", handle });
      if (r.status !== "found") throw new Error(`${handle} not found`);
      const byId = await lookup.resolve({ kind: "id", channelId: r.channel.id });
      expect(byId).toEqual(r);
      const up = await lookup.recentUploads(r.channel, q);
      if (up.status !== "ok") throw new Error("uploads unavailable");
      expect(up.videos.length).toBeGreaterThanOrEqual(30);
      const byVideo = await lookup.resolve({ kind: "video", videoId: up.videos[0]!.id });
      expect(byVideo).toEqual(r);
    }
  });

  it("is deterministic and newest first", async () => {
    const r = await lookup.resolve({ kind: "handle", handle: "mockgolden03" });
    if (r.status !== "found") throw new Error();
    const a = await lookup.recentUploads(r.channel, q);
    const b = await new MockChannelLookup({ now: () => NOW }).recentUploads(r.channel, q);
    expect(a).toEqual(b);
    if (a.status !== "ok") throw new Error();
    const times = a.videos.map((v) => Date.parse(v.publishedAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });

  it("covers the edge cases the playbook must handle", async () => {
    const uploads = async (handle: string) => {
      const r = await lookup.resolve({ kind: "handle", handle });
      if (r.status !== "found") throw new Error(handle);
      const up = await lookup.recentUploads(r.channel, q);
      if (up.status !== "ok") throw new Error(handle);
      return up.videos;
    };
    expect(await uploads("mocktiny")).toHaveLength(6);
    const flat = await uploads("mockflat");
    expect(
      Math.max(...flat.map((v) => v.views)) / Math.min(...flat.map((v) => v.views)),
    ).toBeLessThan(1.3);
    expect((await uploads("mockmixed")).filter((v) => v.durationSeconds > 180)).toHaveLength(8);
    expect((await uploads("mockhidden")).every((v) => v.likes === null)).toBe(true);
    const fresh = (await uploads("mocknew")).filter(
      (v) => NOW.getTime() - Date.parse(v.publishedAt) < 7 * 86_400_000,
    );
    expect(fresh).toHaveLength(8);
    expect(await lookup.resolve({ kind: "handle", handle: MOCK_CHANNEL_NOT_FOUND })).toEqual({
      status: "not_found",
    });
    expect(
      (await lookup.resolve({ kind: "handle", handle: MOCK_CHANNEL_UNAVAILABLE })).status,
    ).toBe("unavailable");
  });

  it("respects the window and the cap", async () => {
    const r = await lookup.resolve({ kind: "id", channelId: mockChannelId("g07") });
    if (r.status !== "found") throw new Error();
    const short = await lookup.recentUploads(r.channel, { maxVideos: 50, windowDays: 30 });
    const capped = await lookup.recentUploads(r.channel, { maxVideos: 10, windowDays: 90 });
    if (short.status !== "ok" || capped.status !== "ok") throw new Error();
    expect(
      short.videos.every((v) => NOW.getTime() - Date.parse(v.publishedAt) <= 30 * 86_400_000),
    ).toBe(true);
    expect(capped.videos).toHaveLength(10);
  });
});

describe("review fixes: errors, window walk, pagination", () => {
  const channel = toChannelInfo(apiChannel) as ChannelInfo;
  const q = { maxVideos: 50, windowDays: 90 };
  const statsFor = (url: URL) => ({
    body: {
      items: url.searchParams
        .get("id")!
        .split(",")
        .map((id) => ({ ...apiVideo(0), id })),
    },
  });

  it("dailyLimitExceeded and bare 429s are quota", async () => {
    const daily = fakeFetch({
      channels: () => ({
        status: 403,
        body: { error: { errors: [{ reason: "dailyLimitExceeded" }] } },
      }),
    });
    expect(await api(daily.fetch).resolve({ kind: "handle", handle: "x1x" })).toEqual({
      status: "unavailable",
      reason: "quota",
    });
    const tooMany = fakeFetch({ channels: () => ({ status: 429, body: {} }) });
    expect(await api(tooMany.fetch).resolve({ kind: "handle", handle: "x1x" })).toEqual({
      status: "unavailable",
      reason: "quota",
    });
  });

  it("one out-of-order old item doesn't end the walk; three in a row do", async () => {
    const at = [1, 2, 120, 3, 4, 100, 101, 102, 5];
    const { fetch } = fakeFetch({
      playlistItems: () => ({
        body: {
          items: at.map((d, i) => ({
            contentDetails: { videoId: vid(i), videoPublishedAt: daysAgo(d) },
          })),
        },
      }),
      videos: statsFor,
    });
    const r = await api(fetch).recentUploads(channel, q);
    expect(r.status === "ok" && r.videos.map((v) => v.id).sort()).toEqual(
      [0, 1, 3, 4].map(vid).sort(),
    );
  });

  it("re-checks the window on each video's own publish date", async () => {
    const { fetch } = fakeFetch({
      playlistItems: () => ({
        body: {
          items: [0, 1].map((i) => ({
            contentDetails: { videoId: vid(i), videoPublishedAt: daysAgo(1) },
          })),
        },
      }),
      videos: () => ({
        body: {
          items: [
            apiVideo(0),
            apiVideo(1, {
              snippet: { title: "Old", publishedAt: daysAgo(200), liveBroadcastContent: "none" },
            }),
          ],
        },
      }),
    });
    const r = await api(fetch).recentUploads(channel, q);
    expect(r.status === "ok" && r.videos.map((v) => v.id)).toEqual([vid(0)]);
  });

  it("follows nextPageToken until the cap", async () => {
    const pages: string[] = [];
    const { fetch } = fakeFetch({
      playlistItems: (url) => {
        const token = url.searchParams.get("pageToken") ?? "first";
        pages.push(token);
        const start = token === "first" ? 0 : 30;
        return {
          body: {
            items: Array.from({ length: 30 }, (_, i) => ({
              contentDetails: { videoId: vid(start + i), videoPublishedAt: daysAgo(1) },
            })),
            nextPageToken: token === "first" ? "second" : "third",
          },
        };
      },
      videos: statsFor,
    });
    const r = await api(fetch).recentUploads(channel, q);
    expect(pages).toEqual(["first", "second"]);
    expect(r.status === "ok" && r.videos).toHaveLength(50);
  });

  it("maxVideos of 0 asks for nothing", async () => {
    const { fetch, calls } = fakeFetch({});
    expect(await api(fetch).recentUploads(channel, { maxVideos: 0, windowDays: 90 })).toEqual({
      status: "ok",
      videos: [],
    });
    expect(calls).toHaveLength(0);
  });
});

describe("review fixes: cache", () => {
  const q = { maxVideos: 50, windowDays: 90 };
  function memCache() {
    const store = new Map<string, string>();
    return {
      store,
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };
  }

  it("refresh skips the cached answer and rewrites it", async () => {
    const cache = memCache();
    const inner = new MockChannelLookup({ now: () => NOW });
    const spy = vi.spyOn(inner, "recentUploads");
    const lookup = new CachedChannelLookup(inner, cache);
    const r = await lookup.resolve({ kind: "handle", handle: "mockgolden01" });
    if (r.status !== "found") throw new Error();
    await lookup.recentUploads(r.channel, q);
    await lookup.recentUploads(r.channel, q, { refresh: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("a corrupt entry or a cache outage is a miss, not a failure", async () => {
    const cache = memCache();
    const inner = new MockChannelLookup({ now: () => NOW });
    const lookup = new CachedChannelLookup(inner, cache);
    cache.store.set("channel:v1:h:mockgolden02", "{not json");
    expect((await lookup.resolve({ kind: "handle", handle: "mockgolden02" })).status).toBe("found");
    const broken = new CachedChannelLookup(inner, {
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => {
        throw new Error("redis down");
      },
    });
    expect((await broken.resolve({ kind: "handle", handle: "mockgolden02" })).status).toBe("found");
  });

  it("remembers not-found briefly; never caches unavailable", async () => {
    const cache = memCache();
    const inner = new MockChannelLookup({ now: () => NOW });
    const spy = vi.spyOn(inner, "resolve");
    const lookup = new CachedChannelLookup(inner, cache);
    await lookup.resolve({ kind: "handle", handle: MOCK_CHANNEL_NOT_FOUND });
    expect(await lookup.resolve({ kind: "handle", handle: MOCK_CHANNEL_NOT_FOUND })).toEqual({
      status: "not_found",
    });
    expect(spy).toHaveBeenCalledOnce();
    await lookup.resolve({ kind: "handle", handle: "MockDown" });
    await lookup.resolve({ kind: "handle", handle: "MockDown" });
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe("golden channels satisfy the PRD's minimum data, with margin", () => {
  // PRD scoring: Shorts <= 180 s and >= 7 days old; baseline = median views; outlier >= 2.0.
  // Asserted at 2.1 so small changes to the generator can't silently break M10's done-when.
  const lookup = new MockChannelLookup({ now: () => NOW });
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  it.each(GOLDEN_CHANNEL_HANDLES)("%s", async (handle) => {
    const r = await lookup.resolve({ kind: "handle", handle });
    if (r.status !== "found") throw new Error();
    const up = await lookup.recentUploads(r.channel, { maxVideos: 50, windowDays: 90 });
    if (up.status !== "ok") throw new Error();
    const eligible = up.videos.filter(
      (v) =>
        v.durationSeconds <= 180 && NOW.getTime() - Date.parse(v.publishedAt) >= 7 * 86_400_000,
    );
    expect(eligible.length).toBeGreaterThanOrEqual(10);
    const base = median(eligible.map((v) => v.views));
    expect(eligible.filter((v) => v.views / base >= 2.1).length).toBeGreaterThanOrEqual(2);
  });
  it("mockflat has no breakouts and mocktiny too few Shorts", async () => {
    const vids = async (handle: string) => {
      const r = await lookup.resolve({ kind: "handle", handle });
      if (r.status !== "found") throw new Error();
      const up = await lookup.recentUploads(r.channel, { maxVideos: 50, windowDays: 90 });
      if (up.status !== "ok") throw new Error();
      return up.videos;
    };
    const flat = await vids("mockflat");
    const base = median(flat.map((v) => v.views));
    expect(flat.filter((v) => v.views / base >= 2).length).toBe(0);
    expect((await vids("mocktiny")).length).toBeLessThan(10);
    expect((await vids("mockhidden")).some((v) => v.comments === null)).toBe(true);
  });
});
