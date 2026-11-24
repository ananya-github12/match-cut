/**
 * M10: channel data and scoring together, on the offline channels. PRD-playbooks.md, Feature 3.
 */
import { scoreChannel, type ScoringResult } from "@match-cut/core";
import { GOLDEN_CHANNEL_HANDLES, MockChannelLookup } from "@match-cut/providers";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-11-24T12:00:00Z");
const lookup = new MockChannelLookup({ now: () => NOW });

async function score(handle: string): Promise<ScoringResult> {
  const r = await lookup.resolve({ kind: "handle", handle });
  if (r.status !== "found") throw new Error(`${handle}: ${r.status}`);
  const up = await lookup.recentUploads(r.channel, { maxVideos: 50, windowDays: 90 });
  if (up.status !== "ok") throw new Error(`${handle}: uploads unavailable`);
  return scoreChannel(up.videos, { now: NOW });
}

describe("golden channels score cleanly", () => {
  it.each(GOLDEN_CHANNEL_HANDLES)("%s", async (handle) => {
    const r = await score(handle);
    if (!r.ok) throw new Error(`${handle}: NOT_ENOUGH_DATA ${JSON.stringify(r)}`);
    expect(r.outliers.length).toBeGreaterThanOrEqual(3);
    expect(r.typical.length).toBeGreaterThanOrEqual(3);
    expect(r.window.shortsEligible).toBeGreaterThanOrEqual(10);
    for (const v of r.outliers) expect(v.outlierScore).toBeGreaterThanOrEqual(2);
  });
});

describe("edge channels produce their intended results", () => {
  it("mocktiny: not enough data", async () => {
    expect(await score("mocktiny")).toMatchObject({
      ok: false,
      code: "NOT_ENOUGH_DATA",
      reasons: expect.arrayContaining(["TOO_FEW_SHORTS"]),
    });
  });
  it("mockflat: no breakouts", async () => {
    expect(await score("mockflat")).toMatchObject({
      ok: false,
      reasons: ["TOO_FEW_BREAKOUTS"],
      outliersFound: 0,
    });
  });
  it("mockmixed: long videos left out, with a warning", async () => {
    const r = await score("mockmixed");
    if (!r.ok) throw new Error();
    expect(r.window.notShort).toBe(8);
    expect(r.warnings.map((w) => w.code)).toContain("MIXED_FORMATS");
  });
  it("mockhidden: hidden likes flagged", async () => {
    const r = await score("mockhidden");
    if (!r.ok) throw new Error();
    expect(r.warnings.map((w) => w.code)).toContain("LIKES_HIDDEN");
  });
  it("mocknew: recent uploads excluded and counted", async () => {
    const r = await score("mocknew");
    if (!r.ok) throw new Error();
    expect(r.window.tooNew).toBe(8);
    expect(r.warnings.map((w) => w.code)).toContain("RECENT_VIDEOS_EXCLUDED");
  });
});
