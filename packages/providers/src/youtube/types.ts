import type { VideoMetadata } from "@match-cut/core";

export type LookupResult =
  | { status: "found"; video: VideoMetadata }
  | { status: "not_found" }
  /** Data API down, over quota or slow. PRD: skip the precheck and rely on Gemini's errors. */
  | { status: "unavailable"; reason: string };

/** Looks a video up by ID. Never receives a user's raw URL. */
export interface VideoLookup {
  lookup(videoId: string): Promise<LookupResult>;
}
