import { describe, expect, it } from "vitest";
import { playbookWarning } from "../errors.js";
import {
  engagementRate,
  median,
  scoreChannel,
  type ScoringResult,
  type ScoringVideo,
} from "./scoring.js";

const NOW = new Date("2026-11-24T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let n = 0;
function video(over: Partial<ScoringVideo> & { days?: number } = {}): ScoringVideo {
  const { days = 10, ...rest } = over;
  n++;
  return {
    id: `vid${String(n).padStart(8, "0")}`,
    title: `Short ${n}`,
    publishedAt: ago(days),
    durationSeconds: 40,
    views: 1000,
    likes: 50,
    comments: 5,
    ...rest,
  };
}

/** `count` Shorts between 900 and 1,100 views (median 1,000), 8+ days old, plus extras. */
function channel(count: number, extras: ScoringVideo[] = []): ScoringVideo[] {
  const base = Array.from({ length: count }, (_, i) =>
    video({ days: 8 + i * 2, views: 900 + (i % 5) * 50 }),
  );
  return [...base, ...extras];
}
/** `count` Shorts at exactly 1,000 views: the median can't move when extras are added. */
function flat(count: number, extras: ScoringVideo[] = []): ScoringVideo[] {
  return [...Array.from({ length: count }, (_, i) => video({ days: 8 + i * 2 })), ...extras];
}
/** Three clear breakouts. */
const three = () => [9, 5, 3].map((m, i) => video({ days: 20 + i, views: 1000 * m }));

function ok(r: ScoringResult) {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.reasons)}`);
  return r;
}
const codes = (r: ScoringResult) => (r.ok ? r.warnings.map((w) => w.code) : []);

describe("median and engagement", () => {
  it("median of odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it("engagement uses whatever is public, never inventing zeros for hidden numbers", () => {
    expect(engagementRate({ views: 1000, likes: 40, comments: 10 })).toBe(0.05);
    expect(engagementRate({ views: 1000, likes: null, comments: 10 })).toBe(0.01);
    expect(engagementRate({ views: 1000, likes: 40, comments: null })).toBe(0.04);
    expect(engagementRate({ views: 1000, likes: null, comments: null })).toBeNull();
    expect(engagementRate({ views: 0, likes: 4, comments: 1 })).toBeNull();
  });
});

describe("scoreChannel (PRD-playbooks.md, Scoring)", () => {
  it("scores against the median of eligible Shorts and picks breakouts and typical videos", () => {
    const [big, mid, small] = three();
    const r = ok(scoreChannel(channel(14, [big!, mid!, small!]), { now: NOW }));
    expect(r.baseline.medianViews).toBe(1000);
    expect(r.outliers.map((v) => v.id)).toEqual([big!.id, mid!.id, small!.id]);
    expect(r.outliers[0]!.outlierScore).toBe(9);
    expect(r.typical).toHaveLength(5);
    expect(r.typical.every((v) => v.outlierScore! >= 0.5 && v.outlierScore! <= 1.5)).toBe(true);
    // Closest to the median first.
    const gaps = r.typical.map((v) => Math.abs(v.views - 1000));
    expect([...gaps].sort((a, b) => a - b)).toEqual(gaps);
    expect(r.videos.filter((v) => v.group === "outlier")).toHaveLength(3);
    expect(r.videos.filter((v) => v.group === "typical")).toHaveLength(5);
  });

  it("the threshold is inclusive, and configurable", () => {
    const extras = [video({ days: 20, views: 2000 }), ...three()];
    expect(ok(scoreChannel(flat(14, extras), { now: NOW })).outliers).toHaveLength(4);
    const r = ok(scoreChannel(flat(14, extras), { now: NOW, outlierThreshold: 2.5 }));
    expect(r.outliers).toHaveLength(3);
  });

  it("at threshold 1.5 a breakout is never also typical", () => {
    const at15 = video({ days: 25, views: 1500 });
    const r = ok(scoreChannel(flat(14, [at15, ...three()]), { now: NOW, outlierThreshold: 1.5 }));
    expect(r.outliers.map((v) => v.id)).toContain(at15.id);
    expect(r.typical.map((v) => v.id)).not.toContain(at15.id);
  });

  it("keeps the top 5 breakouts; ties go to the newer video, then the ID", () => {
    const extras = [10, 9, 8, 7, 6, 5].map((m, i) => video({ days: 9 + i, views: 1000 * m }));
    const tie = video({ days: 40, views: 6000 });
    const r = ok(scoreChannel(channel(14, [...extras, tie]), { now: NOW }));
    expect(r.outliers.map((v) => v.views)).toEqual([10000, 9000, 8000, 7000, 6000]);
    expect(r.outliers[4]!.id).toBe(extras[4]!.id);
    expect(r.videos.find((v) => v.id === tie.id)!.group).toBe("other");
  });

  it("Shorts are 180 s or less; longer uploads are excluded from the baseline", () => {
    const edge = video({ days: 12, durationSeconds: 180, views: 5000 });
    const long = video({ days: 13, durationSeconds: 181, views: 90000 });
    const r = ok(scoreChannel(channel(14, [edge, long, ...three()]), { now: NOW }));
    expect(r.videos.find((v) => v.id === long.id)!.group).toBe("not_short");
    expect(r.outliers.map((v) => v.id)).toContain(edge.id);
    expect(r.window.notShort).toBe(1);
    expect(codes(r)).toContain("MIXED_FORMATS");
  });

  it("exactly 7 days old is eligible; 1 ms younger is too new", () => {
    const seven = video({ days: 7, views: 8000 });
    const almost = video({ publishedAt: new Date(NOW.getTime() - 7 * DAY + 1).toISOString() });
    const r = ok(scoreChannel(channel(14, [seven, almost, ...three()]), { now: NOW }));
    expect(r.outliers.map((v) => v.id)).toContain(seven.id);
    const a = r.videos.find((v) => v.id === almost.id)!;
    expect(a.group).toBe("too_new");
    expect(a.outlierScore).toBeNull();
    expect(r.window.tooNew).toBe(1);
    expect(r.warnings).toContainEqual(
      playbookWarning("RECENT_VIDEOS_EXCLUDED", { count: 1, days: 7 }),
    );
  });

  it("the window start is inclusive; older and future-dated uploads are left out", () => {
    const edge = video({ days: 90, views: 1000 });
    const old = video({ publishedAt: new Date(NOW.getTime() - 90 * DAY - 1).toISOString() });
    const future = video({ days: -1, views: 99999 });
    const r = ok(scoreChannel(channel(14, [edge, old, future, ...three()]), { now: NOW }));
    const ids = r.videos.map((v) => v.id);
    expect(ids).toContain(edge.id);
    expect(ids).not.toContain(old.id);
    expect(ids).not.toContain(future.id);
    expect(r.window.from).toBe(ago(90));
  });

  it("caps at maxVideos newest first, before eligibility (the PRD's 'at most 50 uploads')", () => {
    const fresh = Array.from({ length: 5 }, (_, i) => video({ days: 1 + i }));
    const r = scoreChannel(channel(40, [...fresh, ...three()]), { now: NOW, maxVideos: 12 });
    expect(r.window.uploadsSeen).toBe(12);
    expect(r.window.tooNew).toBe(5);
  });

  it("duplicated IDs: the copy with the most views wins, whatever the order", () => {
    const base = channel(14, three());
    const high = video({ days: 30, views: 5000 });
    const low = { ...high, views: 100 };
    const a = scoreChannel([...base, high, low], { now: NOW });
    const b = scoreChannel([low, ...base.reverse(), high], { now: NOW });
    expect(b).toEqual(a);
    expect(ok(a).outliers.map((v) => v.id)).toContain(high.id);
  });

  it("drops uploads with impossible durations or views, and counts them", () => {
    const bad = [
      video({ durationSeconds: 0 }),
      video({ durationSeconds: Number.NaN }),
      video({ durationSeconds: -5 }),
      video({ views: Number.NaN }),
      video({ views: -1 }),
      video({ views: Number.POSITIVE_INFINITY }),
    ];
    const r = ok(scoreChannel(channel(14, [...bad, ...three()]), { now: NOW }));
    expect(r.window.unusable).toBe(6);
    expect(r.window.shortsEligible).toBe(17);
    expect(r.baseline.medianViews).toBe(1000);
  });

  it("SMALL_SAMPLE at the minimum of 3 on either side, not above it", () => {
    const r = ok(scoreChannel(channel(14, three()), { now: NOW }));
    expect(codes(r)).toContain("SMALL_SAMPLE");
    const four = [9, 6, 4, 3].map((m, i) => video({ days: 20 + i, views: 1000 * m }));
    expect(codes(ok(scoreChannel(channel(14, four), { now: NOW })))).not.toContain("SMALL_SAMPLE");
  });

  it("LIKES_HIDDEN only when a compared video hides likes; engagement median skips unknowns", () => {
    const hidden = video({ days: 20, views: 9000, likes: null, comments: null });
    const r = ok(
      scoreChannel(
        channel(14, [hidden, video({ days: 30, views: 3000 }), video({ days: 31, views: 4000 })]),
        { now: NOW },
      ),
    );
    expect(codes(r)).toContain("LIKES_HIDDEN");
    expect(r.outliers.find((v) => v.id === hidden.id)!.engagementRate).toBeNull();
    expect(r.baseline.medianEngagementRate).toBeGreaterThan(0);
    const offScreen = video({ days: 60, views: 700, likes: null });
    expect(
      codes(ok(scoreChannel(channel(14, [offScreen, ...three()]), { now: NOW }))),
    ).not.toContain("LIKES_HIDDEN");
  });

  describe("NOT_ENOUGH_DATA, with the reason", () => {
    it("exactly 10 eligible Shorts is enough; 9 isn't", () => {
      expect(scoreChannel(channel(7, three()), { now: NOW }).ok).toBe(true);
      const r = scoreChannel(channel(6, three()), { now: NOW });
      expect(r).toMatchObject({ ok: false, code: "NOT_ENOUGH_DATA", reasons: ["TOO_FEW_SHORTS"] });
      if (!r.ok) {
        expect(r.window.shortsEligible).toBe(9);
        expect(r.minimums).toEqual({ eligible: 10, outliers: 3, typical: 3 });
      }
    });
    it("fewer than 3 breakouts", () => {
      const r = scoreChannel(
        channel(20, [video({ days: 20, views: 9000 }), video({ days: 21, views: 4000 })]),
        { now: NOW },
      );
      expect(r).toMatchObject({ ok: false, reasons: ["TOO_FEW_BREAKOUTS"], outliersFound: 2 });
    });
    it("a zero median", () => {
      const zeros = Array.from({ length: 12 }, (_, i) => video({ days: 8 + i, views: 0 }));
      expect(scoreChannel(zeros, { now: NOW })).toMatchObject({
        ok: false,
        reasons: ["NO_VIEWS"],
      });
    });
    it("too little near the median to compare against", () => {
      // 4 x 100, 2 x 300, 4 x 1,000: median 300, 4 breakouts, only 2 typical.
      const views = [100, 100, 100, 100, 300, 300, 1000, 1000, 1000, 1000];
      const vids = views.map((v, i) => video({ days: 8 + i, views: v }));
      expect(scoreChannel(vids, { now: NOW })).toMatchObject({
        ok: false,
        reasons: ["TOO_FEW_TYPICAL"],
        outliersFound: 4,
        typicalFound: 2,
      });
    });
    it("a bimodal channel can fail on both sides at once", () => {
      const tiny = Array.from({ length: 6 }, (_, i) => video({ days: 8 + i, views: 100 }));
      const huge = Array.from({ length: 6 }, (_, i) => video({ days: 20 + i, views: 10000 }));
      expect(scoreChannel([...tiny, ...huge], { now: NOW })).toMatchObject({
        ok: false,
        reasons: ["TOO_FEW_BREAKOUTS", "TOO_FEW_TYPICAL"],
      });
    });
    it("only long-form or only brand-new uploads", () => {
      const long = Array.from({ length: 15 }, (_, i) =>
        video({ days: 8 + i, durationSeconds: 600 }),
      );
      expect(scoreChannel(long, { now: NOW })).toMatchObject({ ok: false });
      const fresh = Array.from({ length: 15 }, (_, i) => video({ days: i * 0.4 }));
      const r = scoreChannel(fresh, { now: NOW });
      expect(r.ok === false && r.reasons).toContain("TOO_FEW_SHORTS");
    });
  });

  it("rejects options outside the PRD's ranges and an invalid clock", () => {
    expect(() => scoreChannel([], { now: NOW, windowDays: 10 })).toThrow(RangeError);
    expect(() => scoreChannel([], { now: NOW, maxVideos: 51 })).toThrow(RangeError);
    expect(() => scoreChannel([], { now: NOW, outlierThreshold: 1 })).toThrow(RangeError);
    expect(() => scoreChannel([], { now: NOW, windowDays: 45.5 })).toThrow(RangeError);
    expect(() => scoreChannel([], { now: new Date("nope") })).toThrow(RangeError);
  });
});

describe("playbook warning copy", () => {
  it("fills the count and the days", () => {
    expect(playbookWarning("RECENT_VIDEOS_EXCLUDED", { count: 3, days: 7 }).message).toBe(
      "3 uploads from the last 7 days were left out because they're still gaining views.",
    );
  });
});
