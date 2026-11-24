/**
 * Playbook scoring: which Shorts count, the channel's baseline, each video's outlier score, and
 * which videos get compared. PRD-playbooks.md, Feature 3 > "Scoring (deterministic code)".
 * Pure: no model calls, no clock reads (`now` is passed in), the same input always gives the same
 * picks whatever order the uploads arrive in.
 *
 * Deviation from the PRD's first draft (recorded in the PRD): the minimum is 3 breakouts and
 * 3 typical videos, not 2 breakouts. The comparison step drops any pattern with fewer than 3
 * known values per group, so 2 breakouts could never produce a rule.
 */
import { playbookWarning, type PlaybookWarning } from "../errors.js";

/** The upload facts scoring needs (the providers' ChannelVideo has these and more). */
export interface ScoringVideo {
  id: string;
  /** Owner-written text: treated as data only. */
  title: string;
  publishedAt: string;
  durationSeconds: number;
  views: number;
  /** null: likes hidden by the creator. */
  likes: number | null;
  /** null: comments turned off. */
  comments: number | null;
}

export interface ScoringOptions {
  now: Date;
  /** 30 to 180, default 90. */
  windowDays?: number;
  /** 10 to 50 uploads considered, newest first, default 50. */
  maxVideos?: number;
  /** 1.5 to 10, default 2.0. */
  outlierThreshold?: number;
}

export const PLAYBOOK_DEFAULTS = { windowDays: 90, maxVideos: 50, outlierThreshold: 2.0 } as const;
export const PLAYBOOK_LIMITS = {
  windowDays: [30, 180],
  maxVideos: [10, 50],
  outlierThreshold: [1.5, 10],
} as const;

/** YouTube has no "is Short" field: duration is the stand-in (PRD open question). */
export const SHORTS_MAX_SECONDS = 180;
/** Younger uploads are still gaining views, so they'd look like underperformers. */
export const MIN_AGE_DAYS = 7;
export const MIN_ELIGIBLE = 10;
/** The comparison needs at least 3 known values per group to keep any rule. */
export const MIN_OUTLIERS = 3;
export const MIN_TYPICAL = 3;
export const MAX_OUTLIERS = 5;
export const MAX_TYPICAL = 5;
export const TYPICAL_RANGE = [0.5, 1.5] as const;
/** At the minimum on either side (3 picks), the patterns are early signals. */
export const SMALL_SAMPLE_PICKS = 4;

/**
 * outlier / typical: compared. other: eligible, not compared. too_new: under 7 days old.
 * not_short: longer than 180 s. The API maps these onto the PRD's `videos[].group`.
 */
export type VideoGroup = "outlier" | "typical" | "other" | "too_new" | "not_short";

export interface ScoredVideo extends ScoringVideo {
  /** views ÷ the channel's median; null when not eligible. */
  outlierScore: number | null;
  /** (likes + comments) ÷ views from whatever is public; null when neither is or views are 0. */
  engagementRate: number | null;
  group: VideoGroup;
}

export interface ScoringWindow {
  from: string;
  to: string;
  /** Uploads in the window, after the cap (newest first). */
  uploadsSeen: number;
  shortsEligible: number;
  tooNew: number;
  notShort: number;
  /** Dropped: missing or impossible duration or view count. */
  unusable: number;
}

/** Why a channel can't get a playbook, so the app can suggest the right next step. */
export type NotEnoughDataReason =
  "NO_VIEWS" | "TOO_FEW_SHORTS" | "TOO_FEW_BREAKOUTS" | "TOO_FEW_TYPICAL";

export type ScoringResult =
  | {
      ok: true;
      /** Every usable upload in the window, newest first, with its group and score. */
      videos: ScoredVideo[];
      /** Highest score first. */
      outliers: ScoredVideo[];
      /** Closest to the median first. */
      typical: ScoredVideo[];
      baseline: { medianViews: number; medianEngagementRate: number | null };
      window: ScoringWindow;
      warnings: PlaybookWarning[];
    }
  | {
      ok: false;
      code: "NOT_ENOUGH_DATA";
      reasons: NotEnoughDataReason[];
      window: ScoringWindow;
      /** Breakouts found (score at or above the threshold), before the top-5 cut. */
      outliersFound: number;
      typicalFound: number;
      minimums: { eligible: number; outliers: number; typical: number };
    };

const DAY = 86_400_000;
const MINIMUMS = { eligible: MIN_ELIGIBLE, outliers: MIN_OUTLIERS, typical: MIN_TYPICAL };

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function engagementRate(
  v: Pick<ScoringVideo, "views" | "likes" | "comments">,
): number | null {
  if (v.likes === null && v.comments === null) return null;
  if (!(v.views > 0)) return null;
  return ((v.likes ?? 0) + (v.comments ?? 0)) / v.views;
}

function inRange(name: keyof typeof PLAYBOOK_LIMITS, value: number) {
  const [lo, hi] = PLAYBOOK_LIMITS[name];
  if (!Number.isFinite(value) || value < lo || value > hi) {
    throw new RangeError(`${name} must be between ${lo} and ${hi}`);
  }
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Newest first; ties broken by ID so input order never matters. */
const newestFirst = (a: ScoringVideo, b: ScoringVideo) =>
  Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || byId(a, b);

const usable = (v: ScoringVideo) =>
  Number.isFinite(v.durationSeconds) &&
  v.durationSeconds > 0 &&
  Number.isFinite(v.views) &&
  v.views >= 0;

export function scoreChannel(uploads: ScoringVideo[], opts: ScoringOptions): ScoringResult {
  const windowDays = opts.windowDays ?? PLAYBOOK_DEFAULTS.windowDays;
  const maxVideos = opts.maxVideos ?? PLAYBOOK_DEFAULTS.maxVideos;
  const threshold = opts.outlierThreshold ?? PLAYBOOK_DEFAULTS.outlierThreshold;
  inRange("windowDays", windowDays);
  inRange("maxVideos", maxVideos);
  inRange("outlierThreshold", threshold);
  if (!Number.isInteger(windowDays) || !Number.isInteger(maxVideos)) {
    throw new RangeError("windowDays and maxVideos must be whole numbers");
  }
  const now = opts.now.getTime();
  if (!Number.isFinite(now)) throw new RangeError("now must be a valid date");
  const from = now - windowDays * DAY;

  // Cached uploads can be up to a day old: re-apply the window with this run's clock.
  // Future dates (clock skew, scheduled premieres) are left out. For a duplicated ID the copy
  // with the most views wins (then the newer one), so input order never changes the result.
  const best = new Map<string, ScoringVideo>();
  for (const v of uploads) {
    const at = Date.parse(v.publishedAt);
    if (!Number.isFinite(at) || at < from || at > now) continue;
    const prev = best.get(v.id);
    if (
      !prev ||
      (Number.isFinite(v.views) ? v.views : -1) > (Number.isFinite(prev.views) ? prev.views : -1) ||
      (v.views === prev.views && at > Date.parse(prev.publishedAt))
    ) {
      best.set(v.id, v);
    }
  }
  // PRD: at most `maxVideos` uploads in the window, newest first, of any length; then eligibility.
  const inWindow = [...best.values()].sort(newestFirst).slice(0, maxVideos);
  const unusable = inWindow.filter((v) => !usable(v)).length;

  const scored: ScoredVideo[] = inWindow.filter(usable).map((v) => {
    const group: VideoGroup =
      v.durationSeconds > SHORTS_MAX_SECONDS
        ? "not_short"
        : now - Date.parse(v.publishedAt) < MIN_AGE_DAYS * DAY
          ? "too_new"
          : "other";
    return { ...v, outlierScore: null, engagementRate: engagementRate(v), group };
  });
  const eligible = scored.filter((v) => v.group === "other");
  const window: ScoringWindow = {
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    uploadsSeen: inWindow.length,
    shortsEligible: eligible.length,
    tooNew: scored.filter((v) => v.group === "too_new").length,
    notShort: scored.filter((v) => v.group === "not_short").length,
    unusable,
  };

  const medianViews = median(eligible.map((v) => v.views));
  const noViews = medianViews === null || medianViews <= 0;
  if (!noViews) for (const v of eligible) v.outlierScore = v.views / medianViews;

  const byScoreDesc = (a: ScoredVideo, b: ScoredVideo) => b.views - a.views || newestFirst(a, b);
  const breakouts = noViews
    ? []
    : eligible.filter((v) => v.outlierScore! >= threshold).sort(byScoreDesc);
  // Below the threshold too, so at threshold 1.5 a breakout can't also be "typical".
  // Closest to the median in views (not the float ratio), then newest, then ID.
  const closeToMedian = noViews
    ? []
    : eligible
        .filter(
          (v) =>
            v.outlierScore! >= TYPICAL_RANGE[0] &&
            v.outlierScore! <= TYPICAL_RANGE[1] &&
            v.outlierScore! < threshold,
        )
        .sort(
          (a, b) =>
            Math.abs(a.views - medianViews!) - Math.abs(b.views - medianViews!) ||
            newestFirst(a, b),
        );

  const reasons: NotEnoughDataReason[] = [];
  if (eligible.length < MIN_ELIGIBLE) reasons.push("TOO_FEW_SHORTS");
  if (noViews) reasons.push("NO_VIEWS");
  else {
    if (breakouts.length < MIN_OUTLIERS) reasons.push("TOO_FEW_BREAKOUTS");
    if (closeToMedian.length < MIN_TYPICAL) reasons.push("TOO_FEW_TYPICAL");
  }
  if (reasons.length) {
    return {
      ok: false,
      code: "NOT_ENOUGH_DATA",
      reasons,
      window,
      outliersFound: breakouts.length,
      typicalFound: closeToMedian.length,
      minimums: MINIMUMS,
    };
  }

  const outliers = breakouts.slice(0, MAX_OUTLIERS);
  const typical = closeToMedian.slice(0, MAX_TYPICAL);
  for (const v of outliers) v.group = "outlier";
  for (const v of typical) v.group = "typical";

  const warnings: PlaybookWarning[] = [];
  if (outliers.length < SMALL_SAMPLE_PICKS || typical.length < SMALL_SAMPLE_PICKS) {
    warnings.push(playbookWarning("SMALL_SAMPLE"));
  }
  if (window.notShort > 0) warnings.push(playbookWarning("MIXED_FORMATS"));
  // Only the compared videos matter: their engagement is what the playbook shows.
  if ([...outliers, ...typical].some((v) => v.likes === null)) {
    warnings.push(playbookWarning("LIKES_HIDDEN"));
  }
  if (window.tooNew > 0) {
    warnings.push(
      playbookWarning("RECENT_VIDEOS_EXCLUDED", { count: window.tooNew, days: MIN_AGE_DAYS }),
    );
  }

  return {
    ok: true,
    videos: scored,
    outliers,
    typical,
    baseline: {
      medianViews: medianViews!,
      medianEngagementRate: median(
        eligible.map((v) => v.engagementRate).filter((r): r is number => r !== null),
      ),
    },
    window,
    warnings,
  };
}
