import type { VideoMetadata } from "@match-cut/core";
import type { LookupResult, VideoLookup } from "./types.js";

const video = (id: string, over: Partial<VideoMetadata> = {}): VideoMetadata => ({
  id,
  title: `Mock video ${id}`,
  channel: "Mock Channel",
  thumbnailUrl: null,
  durationSeconds: 60,
  privacyStatus: "public",
  embeddable: true,
  ageRestricted: false,
  regionRestriction: null,
  liveBroadcastContent: "none",
  ...over,
});

/**
 * Fixture IDs for every precheck case, usable in tests, the UI and demos.
 * Any other valid ID resolves to a generic public 60-second video, so real links work offline.
 */
export const MOCK_VIDEOS = {
  short: video("mockShort01", { title: "Mock talking-head Short", durationSeconds: 45 }),
  tutorial: video("mockTutor01", { title: "Mock screen-recording tutorial", durationSeconds: 480 }),
  long: video("mockLong001", { title: "Mock 25-minute podcast", durationSeconds: 1500 }),
  private: video("mockPrivat1", { privacyStatus: "private" }),
  unlisted: video("mockUnlist1", { privacyStatus: "unlisted" }),
  ageRestricted: video("mockAgeRst1", { ageRestricted: true }),
  regionBlocked: video("mockRegion1", { regionRestriction: { blocked: ["US"] } }),
  live: video("mockLiveNw1", { liveBroadcastContent: "live", durationSeconds: 0 }),
  premiere: video("mockPremr01", { liveBroadcastContent: "upcoming", durationSeconds: 0 }),
  embedDisabled: video("mockNoEmbd1", { embeddable: false }),
  tiny: video("mockTiny001", { durationSeconds: 2 }),
  montage: video("mockMontg01", { title: "Mock travel montage", durationSeconds: 50 }),
} as const;

export const MOCK_NOT_FOUND_ID = "mockGone001";
export const MOCK_UNAVAILABLE_ID = "mockDown001";

const byId = new Map<string, VideoMetadata>(Object.values(MOCK_VIDEOS).map((v) => [v.id, v]));

export class MockVideoLookup implements VideoLookup {
  async lookup(videoId: string): Promise<LookupResult> {
    if (videoId === MOCK_NOT_FOUND_ID) return { status: "not_found" };
    if (videoId === MOCK_UNAVAILABLE_ID) return { status: "unavailable", reason: "mock" };
    return { status: "found", video: byId.get(videoId) ?? video(videoId) };
  }
}
