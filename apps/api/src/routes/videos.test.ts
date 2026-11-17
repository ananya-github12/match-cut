import { MOCK_NOT_FOUND_ID, MOCK_UNAVAILABLE_ID, MOCK_VIDEOS } from "@match-cut/providers";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { memoryDeps } from "../testing.js";

const app = buildApp(memoryDeps());
const auth = { authorization: "Bearer test-token" };
const get = (id: string, headers: Record<string, string> = auth) =>
  app.inject({ method: "GET", url: `/v1/videos/${id}`, headers });

describe("GET /v1/videos/{id}", () => {
  it("returns the preview for a usable video", async () => {
    const res = await get(MOCK_VIDEOS.short.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: "mockShort01",
      precheck: "ok",
      video: {
        id: "mockShort01",
        title: "Mock talking-head Short",
        channel: "Mock Channel",
        thumbnail_url: null,
        duration_seconds: 45,
        embeddable: true,
      },
      blocking_error: null,
      requires_clip_range: false,
      warnings: [],
    });
  });

  it.each([
    [MOCK_NOT_FOUND_ID, "VIDEO_NOT_FOUND", "This video has been removed or the link is wrong."],
    [
      MOCK_VIDEOS.private.id,
      "VIDEO_NOT_PUBLIC",
      "This video is private or unlisted. Match Cut can only watch public videos.",
    ],
    [
      MOCK_VIDEOS.unlisted.id,
      "VIDEO_NOT_PUBLIC",
      "This video is private or unlisted. Match Cut can only watch public videos.",
    ],
    [
      MOCK_VIDEOS.ageRestricted.id,
      "VIDEO_RESTRICTED",
      "This video is age-restricted or blocked in our region.",
    ],
    [
      MOCK_VIDEOS.regionBlocked.id,
      "VIDEO_RESTRICTED",
      "This video is age-restricted or blocked in our region.",
    ],
    [
      MOCK_VIDEOS.live.id,
      "LIVE_NOT_SUPPORTED",
      "This video is live or hasn't premiered yet. Try again once it has ended.",
    ],
    [
      MOCK_VIDEOS.premiere.id,
      "LIVE_NOT_SUPPORTED",
      "This video is live or hasn't premiered yet. Try again once it has ended.",
    ],
    [
      MOCK_VIDEOS.tiny.id,
      "NO_ANALYZABLE_CONTENT",
      "There isn't enough in this video to study. It may be too short or blank.",
    ],
  ])("%s shows %s with the PRD's message", async (id, code, message) => {
    const res = await get(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().blocking_error).toEqual({ code, message, retryable: false });
  });

  it("a video over 20 minutes is not blocked but asks for a clip range", async () => {
    const body = (await get(MOCK_VIDEOS.long.id)).json();
    expect(body.blocking_error).toBeNull();
    expect(body.requires_clip_range).toBe(true);
  });

  it("embedding disabled comes back as a warning with the PRD's copy", async () => {
    const body = (await get(MOCK_VIDEOS.embedDisabled.id)).json();
    expect(body.warnings).toEqual([
      { code: "EMBED_DISABLED", message: "The creator has turned off playback outside YouTube." },
    ]);
  });

  it("Data API down: precheck skipped, no preview, nothing blocking", async () => {
    const body = (await get(MOCK_UNAVAILABLE_ID)).json();
    expect(body).toMatchObject({ precheck: "skipped", video: null, blocking_error: null });
  });

  it("a malformed ID is 400 INVALID_URL", async () => {
    const res = await get("not-an-id");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        code: "INVALID_URL",
        message: "That doesn't look like a YouTube link.",
        retryable: false,
      },
    });
  });

  it("a missing or wrong token is 401 UNAUTHORIZED", async () => {
    for (const headers of <Record<string, string>[]>[
      {},
      { authorization: "Bearer nope" },
      { authorization: "test-token" },
    ]) {
      const res = await get(MOCK_VIDEOS.short.id, headers);
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toEqual({
        code: "UNAUTHORIZED",
        message: "Your session has ended.",
        retryable: false,
      });
    }
  });
});
