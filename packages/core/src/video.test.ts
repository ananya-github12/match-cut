import { describe, expect, it } from "vitest";
import { classifyVideoState, resolveClipRange, type VideoMetadata } from "./video.js";

const base: VideoMetadata = {
  id: "dQw4w9WgXcQ",
  title: "A video",
  channel: "A channel",
  thumbnailUrl: null,
  durationSeconds: 60,
  privacyStatus: "public",
  embeddable: true,
  ageRestricted: false,
  regionRestriction: null,
  liveBroadcastContent: "none",
};
const state = (over: Partial<VideoMetadata>, region = "US") =>
  classifyVideoState({ ...base, ...over }, region);

// "Video state" table. VIDEO_NOT_FOUND has no metadata and is covered in the precheck tests.
describe("Video state (PRD table)", () => {
  it("a normal public video passes", () => {
    expect(state({})).toEqual({ error: null, warnings: [] });
  });
  it("private or unlisted is VIDEO_NOT_PUBLIC", () => {
    expect(state({ privacyStatus: "private" }).error).toBe("VIDEO_NOT_PUBLIC");
    expect(state({ privacyStatus: "unlisted" }).error).toBe("VIDEO_NOT_PUBLIC");
  });
  it("age-restricted is VIDEO_RESTRICTED", () => {
    expect(state({ ageRestricted: true }).error).toBe("VIDEO_RESTRICTED");
  });
  it("blocked in the server's region is VIDEO_RESTRICTED", () => {
    expect(state({ regionRestriction: { blocked: ["us", "DE"] } }).error).toBe("VIDEO_RESTRICTED");
    expect(state({ regionRestriction: { allowed: ["IN", "GB"] } }).error).toBe("VIDEO_RESTRICTED");
    expect(state({ regionRestriction: { allowed: ["US"] } }).error).toBeNull();
    expect(state({ regionRestriction: { blocked: ["DE"] } }).error).toBeNull();
    expect(state({ regionRestriction: { blocked: ["US"] } }, "IN").error).toBeNull();
  });
  it("live now or an unaired premiere is LIVE_NOT_SUPPORTED, even with duration 0", () => {
    expect(state({ liveBroadcastContent: "live", durationSeconds: 0 }).error).toBe(
      "LIVE_NOT_SUPPORTED",
    );
    expect(state({ liveBroadcastContent: "upcoming", durationSeconds: 0 }).error).toBe(
      "LIVE_NOT_SUPPORTED",
    );
  });
  it("an ended livestream VOD is a normal video", () => {
    expect(state({ liveBroadcastContent: "none", durationSeconds: 5400 })).toEqual({
      error: null,
      warnings: [],
    });
  });
  it("embedding disabled analyzes normally with an EMBED_DISABLED warning", () => {
    expect(state({ embeddable: false })).toEqual({ error: null, warnings: ["EMBED_DISABLED"] });
  });
  it("a video 3 s or shorter is NO_ANALYZABLE_CONTENT", () => {
    expect(state({ durationSeconds: 3 }).error).toBe("NO_ANALYZABLE_CONTENT");
    expect(state({ durationSeconds: 4 }).error).toBeNull();
  });
});

const clip = (start?: number, end?: number) => ({ start_seconds: start, end_seconds: end });

describe("Length and clip range (PRD table)", () => {
  it("video up to 20 minutes, no clip: whole video", () => {
    expect(resolveClipRange(undefined, 1200)).toEqual({ ok: true, range: null, warnings: [] });
    expect(resolveClipRange({}, 900)).toEqual({ ok: true, range: null, warnings: [] });
  });
  it("video over 20 minutes, no clip: VIDEO_TOO_LONG", () => {
    expect(resolveClipRange(undefined, 1201)).toEqual({ ok: false, code: "VIDEO_TOO_LONG" });
  });
  it("a clip on a long video is fine", () => {
    expect(resolveClipRange(clip(3000, 3300), 7200)).toMatchObject({
      ok: true,
      range: { start_seconds: 3000, end_seconds: 3300 },
    });
  });
  it("clip range over 10 minutes: INVALID_CLIP_RANGE", () => {
    expect(resolveClipRange(clip(0, 601), 1200)).toEqual({ ok: false, code: "INVALID_CLIP_RANGE" });
    expect(resolveClipRange(clip(0, 600), 1200).ok).toBe(true);
  });
  it("start only: start to the end, capped at 10 minutes", () => {
    expect(resolveClipRange(clip(100), 300)).toEqual({
      ok: true,
      range: { start_seconds: 100, end_seconds: 300 },
      warnings: [],
    });
    expect(resolveClipRange(clip(100), 7200)).toEqual({
      ok: true,
      range: { start_seconds: 100, end_seconds: 700 },
      warnings: [],
    });
  });
  it("end only: 0:00 to end", () => {
    expect(resolveClipRange(clip(undefined, 45), 300)).toEqual({
      ok: true,
      range: { start_seconds: 0, end_seconds: 45 },
      warnings: [],
    });
  });
  it("end past the duration: clamp with CLIP_CLAMPED", () => {
    expect(resolveClipRange(clip(10, 400), 125)).toEqual({
      ok: true,
      range: { start_seconds: 10, end_seconds: 125 },
      warnings: [{ code: "CLIP_CLAMPED", vars: { duration: "2:05" } }],
    });
  });
  it("start at or past duration, end before start, or under 3 s: INVALID_CLIP_RANGE", () => {
    const bad = { ok: false, code: "INVALID_CLIP_RANGE" };
    expect(resolveClipRange(clip(300), 300)).toEqual(bad);
    expect(resolveClipRange(clip(301, 310), 300)).toEqual(bad);
    expect(resolveClipRange(clip(50, 40), 300)).toEqual(bad);
    expect(resolveClipRange(clip(50, 50), 300)).toEqual(bad);
    expect(resolveClipRange(clip(50, 52), 300)).toEqual(bad);
    expect(resolveClipRange(clip(50, 53), 300).ok).toBe(true);
    expect(resolveClipRange(clip(298), 300)).toEqual(bad); // only 2 s left
    expect(resolveClipRange(clip(290, 500), 292)).toEqual(bad); // clamped to 2 s
  });
  it("seconds only: fractional or negative values are INVALID_CLIP_RANGE", () => {
    expect(resolveClipRange(clip(1.5, 10), 300).ok).toBe(false);
    expect(resolveClipRange(clip(-1, 10), 300).ok).toBe(false);
  });
  it("without a duration (precheck skipped), only duration-free checks run", () => {
    expect(resolveClipRange(undefined, undefined)).toEqual({ ok: true, range: null, warnings: [] });
    expect(resolveClipRange(clip(0, 601), undefined).ok).toBe(false);
    expect(resolveClipRange(clip(10, 12), undefined).ok).toBe(false);
    expect(resolveClipRange(clip(10), undefined)).toMatchObject({
      ok: true,
      range: { start_seconds: 10, end_seconds: 610 },
    });
  });
});
