import { describe, expect, it } from "vitest";
import { checkVideo, precheck } from "./precheck.js";
import {
  MOCK_NOT_FOUND_ID,
  MOCK_UNAVAILABLE_ID,
  MOCK_VIDEOS,
  MockVideoLookup,
} from "./youtube/mock.js";

const lookup = new MockVideoLookup();
const opts = { region: "US" };

describe("precheck: every video-state row returns the PRD's code", () => {
  const cases: [string, string, string | null][] = [
    ["deleted or never existed", MOCK_NOT_FOUND_ID, "VIDEO_NOT_FOUND"],
    ["private", MOCK_VIDEOS.private.id, "VIDEO_NOT_PUBLIC"],
    ["unlisted", MOCK_VIDEOS.unlisted.id, "VIDEO_NOT_PUBLIC"],
    ["age-restricted", MOCK_VIDEOS.ageRestricted.id, "VIDEO_RESTRICTED"],
    ["blocked in the server's region", MOCK_VIDEOS.regionBlocked.id, "VIDEO_RESTRICTED"],
    ["live now", MOCK_VIDEOS.live.id, "LIVE_NOT_SUPPORTED"],
    ["premiere not yet aired", MOCK_VIDEOS.premiere.id, "LIVE_NOT_SUPPORTED"],
    ["3 s or shorter", MOCK_VIDEOS.tiny.id, "NO_ANALYZABLE_CONTENT"],
    ["over 20 minutes without a clip", MOCK_VIDEOS.long.id, "VIDEO_TOO_LONG"],
    ["a normal Short", MOCK_VIDEOS.short.id, null],
  ];
  it.each(cases)("%s", async (_name, id, code) => {
    const r = await precheck(lookup, id, undefined, opts);
    if (code === null) expect(r.ok).toBe(true);
    else expect(r).toMatchObject({ ok: false, code });
  });

  it("embedding disabled: analyzes with an EMBED_DISABLED warning", async () => {
    const r = await precheck(lookup, MOCK_VIDEOS.embedDisabled.id, undefined, opts);
    expect(r).toMatchObject({ ok: true, warnings: [{ code: "EMBED_DISABLED" }] });
  });

  it("a long video with a clip range is accepted", async () => {
    const r = await precheck(
      lookup,
      MOCK_VIDEOS.long.id,
      { start_seconds: 60, end_seconds: 300 },
      opts,
    );
    expect(r).toMatchObject({ ok: true, range: { start_seconds: 60, end_seconds: 300 } });
  });

  it("clamps an end past the duration with CLIP_CLAMPED", async () => {
    const r = await precheck(
      lookup,
      MOCK_VIDEOS.short.id,
      { start_seconds: 0, end_seconds: 90 },
      opts,
    );
    expect(r).toMatchObject({
      ok: true,
      range: { start_seconds: 0, end_seconds: 45 },
      warnings: [{ code: "CLIP_CLAMPED", vars: { duration: "0:45" } }],
    });
  });

  it("Data API down: skips the precheck and lets the job continue", async () => {
    const r = await precheck(lookup, MOCK_UNAVAILABLE_ID, undefined, opts);
    expect(r).toEqual({ ok: true, video: null, skipped: true, range: null, warnings: [] });
  });

  it("Data API down: duration-free clip checks still run", async () => {
    const r = await precheck(
      lookup,
      MOCK_UNAVAILABLE_ID,
      { start_seconds: 0, end_seconds: 900 },
      opts,
    );
    expect(r).toMatchObject({ ok: false, code: "INVALID_CLIP_RANGE" });
  });

  it("the region is configurable", async () => {
    const r = await checkVideo(lookup, MOCK_VIDEOS.regionBlocked.id, { region: "IN" });
    expect(r.ok).toBe(true);
  });
});
