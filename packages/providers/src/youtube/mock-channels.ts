/**
 * Offline channels for playbooks: deterministic uploads and stats, relative to "now".
 * Ten golden channels (PRD-playbooks.md, M10 "done when") plus one channel per edge case.
 * Video IDs are 11 characters starting with "m" + a 3-character channel code, so they never
 * collide with MOCK_VIDEOS; MockAnalyzer watches them with its default fixture.
 */
import { MODEL_FEATURES, UNKNOWN, type ChannelRef, type ModelFeature } from "@match-cut/core";
import type {
  ChannelInfo,
  ChannelLookup,
  ChannelResult,
  ChannelVideo,
  UploadsQuery,
  UploadsResult,
} from "./channel.js";

export interface MockChannelSpec {
  handle: string;
  /** 3 characters, unique: used in channel and video IDs. */
  code: string;
  title: string;
  subscribers: number | null;
  uploads: number;
  /** Uploads spread evenly over this many days, newest first. */
  daysSpan: number;
  baseViews: number;
  /** Upload index (0 = newest) to views multiplier. */
  outliers: Record<number, number>;
  /** Uploads (by index) that are long-form (10 minutes). */
  longForm?: number[];
  /** The newest this-many uploads land in the last 6 days. */
  tooNew?: number;
  hideLikes?: boolean;
  /** Comments are off on every other upload. */
  commentsOffSometimes?: boolean;
  /** All views within ±10% of the base: no breakouts. */
  flat?: boolean;
  /** Titles of outliers share this topic (for "what the edit doesn't explain"). */
  outlierTopic?: string;
  /**
   * The planted truth for evals: every breakout (multiplier >= 2) has these feature values and
   * other uploads never do. The offline feature extractor reads it.
   */
  pattern?: Partial<Record<ModelFeature, string>>;
  /** The oldest breakout breaks the first pattern feature (a counterexample). */
  counterexample?: boolean;
}

/** Patterns planted in the golden channels, one per channel in rotation. */
export const MOCK_PATTERNS: Partial<Record<ModelFeature, string>>[] = [
  { hook_type: "question", caption_style: "word_by_word" },
  { hook_type: "result_first", zoom_punch_ins: "frequent" },
  { first_words_timing: "under_1s", text_on_screen_first_second: "yes" },
  { hook_type: "bold_claim", music: "trending_or_upbeat" },
  { ending: "loop", caption_style: "word_by_word" },
];

const golden = (n: number, over: Partial<MockChannelSpec> = {}): MockChannelSpec => ({
  pattern: MOCK_PATTERNS[(n - 1) % MOCK_PATTERNS.length],
  counterexample: n === 3 || n === 7,
  handle: `mockgolden${String(n).padStart(2, "0")}`,
  code: `g${String(n).padStart(2, "0")}`,
  title: `Mock Golden Channel ${n}`,
  subscribers: 1000 * 10 ** (n % 4) + 7000 * n,
  uploads: 30 + n,
  daysSpan: 88,
  baseViews: 2000 * n,
  outliers: { [3 + n]: 3 + (n % 4), [9 + n]: 5, [15 + n]: 8 + n, [21]: 2.6 },
  ...over,
});

export const MOCK_CHANNEL_SPECS: MockChannelSpec[] = [
  golden(1),
  golden(2, { outlierTopic: "budget" }),
  golden(3, { hideLikes: true }),
  golden(4),
  golden(5, { tooNew: 3 }),
  golden(6, { outliers: { 2: 4, 8: 6, 14: 3.5, 20: 12, 26: 2.2 } }),
  golden(7),
  golden(8, { outlierTopic: "morning routine" }),
  golden(9, { longForm: [5, 17] }),
  golden(10, { subscribers: null }),
  // Edge cases.
  {
    handle: "mocktiny",
    code: "tny",
    title: "Mock Tiny Channel",
    subscribers: 900,
    uploads: 6,
    daysSpan: 80,
    baseViews: 500,
    outliers: { 2: 4 },
  },
  {
    handle: "mockflat",
    code: "flt",
    title: "Mock Flat Channel",
    subscribers: 52000,
    uploads: 25,
    daysSpan: 85,
    baseViews: 8000,
    outliers: {},
    flat: true,
  },
  {
    handle: "mockmixed",
    code: "mix",
    title: "Mock Mixed Formats",
    subscribers: 310000,
    uploads: 36,
    daysSpan: 89,
    baseViews: 15000,
    outliers: { 4: 5, 11: 3, 19: 7 },
    longForm: [1, 6, 9, 13, 22, 27, 30, 33],
  },
  {
    handle: "mockhidden",
    code: "hid",
    title: "Mock Hidden Likes",
    subscribers: 44000,
    uploads: 28,
    daysSpan: 86,
    baseViews: 6000,
    outliers: { 3: 4, 12: 6, 20: 3 },
    hideLikes: true,
    commentsOffSometimes: true,
  },
  {
    handle: "mocknew",
    code: "new",
    title: "Mock New Uploads",
    subscribers: 18000,
    uploads: 30,
    daysSpan: 87,
    baseViews: 4000,
    outliers: { 10: 5, 16: 4, 24: 3 },
    tooNew: 8,
  },
];

export const GOLDEN_CHANNEL_HANDLES = MOCK_CHANNEL_SPECS.filter((s) =>
  s.handle.startsWith("mockgolden"),
).map((s) => s.handle);

/** Handles that resolve to "not found" and "Data API unavailable". */
export const MOCK_CHANNEL_NOT_FOUND = "mockgone";
export const MOCK_CHANNEL_UNAVAILABLE = "mockdown";

/** Small, seeded PRNG (mulberry32) so mock stats never change between runs. */
function rng(seed: string): () => number {
  let a = [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0, 7);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = ["productivity", "cooking", "travel", "fitness", "tech tips", "study hacks"];

export function mockChannelId(code: string): string {
  return `UCmock${code}`.padEnd(24, "x").slice(0, 24);
}

export function mockVideoId(code: string, index: number): string {
  return `m${code}v${String(index).padStart(6, "0")}`;
}

export function mockChannelInfo(spec: MockChannelSpec): ChannelInfo {
  return {
    id: mockChannelId(spec.code),
    title: spec.title,
    handle: spec.handle,
    subscriberCount: spec.subscribers,
    subscriberCountHidden: spec.subscribers === null,
    uploadsPlaylistId: `UU${mockChannelId(spec.code).slice(2)}`,
    thumbnailUrl: null,
  };
}

export function mockUploads(spec: MockChannelSpec, now: Date): ChannelVideo[] {
  const rand = rng(spec.code);
  const tooNew = spec.tooNew ?? 0;
  const step = spec.daysSpan / spec.uploads;
  return Array.from({ length: spec.uploads }, (_, i) => {
    const daysAgo = i < tooNew ? 0.5 + (i * 5.5) / Math.max(1, tooNew) : 7 + i * step;
    const spread = spec.flat ? 0.9 + rand() * 0.2 : 0.6 + rand() * 0.8;
    const multiplier = spec.outliers[i] ?? 1;
    const views = Math.round(spec.baseViews * spread * multiplier);
    const isOutlier = multiplier >= 2;
    const topic = isOutlier && spec.outlierTopic ? spec.outlierTopic : TOPICS[i % TOPICS.length]!;
    const long = spec.longForm?.includes(i) ?? false;
    return {
      id: mockVideoId(spec.code, i),
      title: `${spec.title} Short ${i + 1}: ${topic}`,
      publishedAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
      durationSeconds: long ? 600 : 20 + Math.round(rand() * 38),
      views,
      likes: spec.hideLikes ? null : Math.round(views * (0.03 + rand() * 0.04)),
      comments:
        spec.commentsOffSometimes && i % 2 === 1
          ? null
          : Math.round(views * (0.002 + rand() * 0.004)),
      liveBroadcastContent: "none" as const,
    };
  });
}

export class MockChannelLookup implements ChannelLookup {
  private readonly now: () => Date;
  private readonly specs: MockChannelSpec[];

  constructor(opts: { now?: () => Date; specs?: MockChannelSpec[] } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.specs = opts.specs ?? MOCK_CHANNEL_SPECS;
  }

  private find(ref: ChannelRef): MockChannelSpec | undefined {
    switch (ref.kind) {
      case "handle":
        return this.specs.find((s) => s.handle.toLowerCase() === ref.handle.toLowerCase());
      case "id":
        return this.specs.find((s) => mockChannelId(s.code) === ref.channelId);
      case "username":
        return undefined;
      case "video":
        return this.specs.find((s) => ref.videoId.startsWith(`m${s.code}v`));
    }
  }

  async resolve(ref: ChannelRef): Promise<ChannelResult> {
    if (ref.kind === "handle" && ref.handle.toLowerCase() === MOCK_CHANNEL_UNAVAILABLE) {
      return { status: "unavailable", reason: "mock" };
    }
    const spec = this.find(ref);
    return spec ? { status: "found", channel: mockChannelInfo(spec) } : { status: "not_found" };
  }

  async recentUploads(channel: ChannelInfo, query: UploadsQuery): Promise<UploadsResult> {
    const spec = this.specs.find((s) => mockChannelId(s.code) === channel.id);
    if (!spec) return { status: "ok", videos: [] };
    const now = this.now();
    const since = now.getTime() - query.windowDays * 86_400_000;
    const videos = mockUploads(spec, now)
      .filter((v) => Date.parse(v.publishedAt) >= since)
      .slice(0, query.maxVideos);
    return { status: "ok", videos };
  }
}

/** The spec and upload index behind an offline video ID, if it belongs to a mock channel. */
export function mockVideoSource(
  videoId: string,
  specs: MockChannelSpec[] = MOCK_CHANNEL_SPECS,
): { spec: MockChannelSpec; index: number } | null {
  const m = /^m(.{3})v(\d{6})$/.exec(videoId);
  if (!m) return null;
  const spec = specs.find((s) => s.code === m[1]);
  return spec ? { spec, index: Number(m[2]) } : null;
}

/**
 * Offline feature extraction: breakouts of a channel with a planted pattern carry it, other
 * uploads never do; every other feature is seeded noise, about 1 in 10 answered "unknown".
 */
export function mockFeatures(
  videoId: string,
  specs: MockChannelSpec[] = MOCK_CHANNEL_SPECS,
): Record<ModelFeature, string> {
  const source = mockVideoSource(videoId, specs);
  const spec = source?.spec;
  const index = source?.index ?? 0;
  const isBreakout = spec ? (spec.outliers[index] ?? 1) >= 2 : false;
  const breakoutIndexes = spec
    ? Object.entries(spec.outliers)
        .filter(([, m]) => m >= 2)
        .map(([i]) => Number(i))
    : [];
  const counterexampleAt = spec?.counterexample ? Math.max(...breakoutIndexes) : -1;
  const firstPatternFeature = spec?.pattern ? (Object.keys(spec.pattern)[0] as ModelFeature) : null;

  const row = {} as Record<ModelFeature, string>;
  for (const feature of Object.keys(MODEL_FEATURES) as ModelFeature[]) {
    const rand = rng(`${videoId}:${feature}`);
    const allowed = MODEL_FEATURES[feature] as readonly string[];
    const planted = spec?.pattern?.[feature];
    const notPlanted = planted ? allowed.filter((v) => v !== planted) : [...allowed];
    const pick = (from: readonly string[]) => from[Math.floor(rand() * from.length)]!;
    if (planted && isBreakout && !(index === counterexampleAt && feature === firstPatternFeature)) {
      row[feature] = planted;
    } else if (rand() < 0.1) {
      row[feature] = UNKNOWN;
    } else {
      row[feature] = pick(notPlanted);
    }
  }
  return row;
}
