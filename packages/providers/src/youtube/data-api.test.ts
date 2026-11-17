import { describe, expect, it, vi } from "vitest";
import { YouTubeDataApiLookup } from "./data-api.js";

const ID = "dQw4w9WgXcQ";
const item = {
  id: ID,
  snippet: {
    title: "A real-looking video",
    channelTitle: "Some Channel",
    liveBroadcastContent: "none",
    thumbnails: {
      default: { url: "https://i.ytimg.com/vi/x/default.jpg" },
      high: { url: "https://i.ytimg.com/vi/x/hqdefault.jpg" },
    },
  },
  contentDetails: {
    duration: "PT3M32S",
    regionRestriction: { blocked: ["DE"] },
    contentRating: {},
  },
  status: { privacyStatus: "public", embeddable: true },
};

function lookupWith(response: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return {
    fetchMock,
    lookup: new YouTubeDataApiLookup({ apiKey: "KEY", fetch: fetchMock as typeof fetch }),
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("YouTubeDataApiLookup", () => {
  it("maps a found video and keeps the key out of the URL", async () => {
    const { lookup, fetchMock } = lookupWith(json({ items: [item] }));
    const r = await lookup.lookup(ID);
    expect(r).toEqual({
      status: "found",
      video: {
        id: ID,
        title: "A real-looking video",
        channel: "Some Channel",
        thumbnailUrl: "https://i.ytimg.com/vi/x/hqdefault.jpg",
        durationSeconds: 212,
        privacyStatus: "public",
        embeddable: true,
        ageRestricted: false,
        regionRestriction: { blocked: ["DE"] },
        liveBroadcastContent: "none",
      },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet%2CcontentDetails%2Cstatus&id=${ID}`,
    );
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("KEY");
  });

  it("maps age restriction, live state and disabled embedding", async () => {
    const { lookup } = lookupWith(
      json({
        items: [
          {
            ...item,
            snippet: { ...item.snippet, liveBroadcastContent: "upcoming" },
            contentDetails: { duration: "P0D", contentRating: { ytRating: "ytAgeRestricted" } },
            status: { privacyStatus: "unlisted", embeddable: false },
          },
        ],
      }),
    );
    const r = await lookup.lookup(ID);
    expect(r).toMatchObject({
      status: "found",
      video: {
        ageRestricted: true,
        liveBroadcastContent: "upcoming",
        durationSeconds: 0,
        privacyStatus: "unlisted",
        embeddable: false,
        regionRestriction: null,
      },
    });
  });

  it("returns not_found when there are no items (deleted or never existed)", async () => {
    const { lookup } = lookupWith(json({ items: [] }));
    expect(await lookup.lookup(ID)).toEqual({ status: "not_found" });
  });

  it("returns unavailable on quota errors, server errors, network errors and timeouts", async () => {
    expect(await lookupWith(json({ error: {} }, 403)).lookup.lookup(ID)).toEqual({
      status: "unavailable",
      reason: "http_403",
    });
    expect(await lookupWith(json({}, 503)).lookup.lookup(ID)).toMatchObject({
      status: "unavailable",
    });
    expect(await lookupWith(new TypeError("fetch failed")).lookup.lookup(ID)).toEqual({
      status: "unavailable",
      reason: "network",
    });
    const timeout = new DOMException("timed out", "TimeoutError");
    expect(await lookupWith(timeout).lookup.lookup(ID)).toEqual({
      status: "unavailable",
      reason: "timeout",
    });
  });

  it("gives up after the 2-second budget", async () => {
    const slow = vi.fn(
      (_url: URL, init: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    );
    const lookup = new YouTubeDataApiLookup({
      apiKey: "KEY",
      timeoutMs: 50,
      fetch: slow as unknown as typeof fetch,
    });
    expect(await lookup.lookup(ID)).toEqual({ status: "unavailable", reason: "timeout" });
  });

  it("refuses anything that isn't a validated ID", async () => {
    const { lookup } = lookupWith(json({}));
    await expect(lookup.lookup("https://evil.example")).rejects.toThrow();
  });
});
