import { describe, expect, it } from "vitest";
import { compareFeatures, titleWords, type ComparedVideo } from "./compare.js";
import { FEATURE_NAMES, type FeatureName, type FeatureRow } from "./features.js";

let n = 0;
/** A row of "unknown" with the given features set. */
function v(features: Partial<Record<FeatureName, string>>, title = "a short"): ComparedVideo {
  const row = Object.fromEntries(FEATURE_NAMES.map((f) => [f, "unknown"])) as FeatureRow;
  return {
    videoId: `vid${String(++n).padStart(8, "0")}`,
    title,
    features: { ...row, ...features },
  };
}
const many = (count: number, features: Partial<Record<FeatureName, string>>, title?: string) =>
  Array.from({ length: count }, () => v(features, title));

describe("compareFeatures confidence (PRD-playbooks.md, Comparison)", () => {
  it("high: >= 80% of outliers, <= 30% of typical, with >= 4 outliers known", () => {
    const outliers = [...many(4, { hook_type: "question" }), v({ hook_type: "bold_claim" })];
    const typical = [
      ...many(3, { hook_type: "bold_claim" }),
      v({ hook_type: "question" }),
      v({ hook_type: "other" }),
    ];
    const r = compareFeatures(outliers, typical);
    expect(r.rules[0]).toMatchObject({
      feature: "hook_type",
      value: "question",
      confidence: "high",
      outliersWith: 4,
      outliersKnown: 5,
      typicalWith: 1,
      typicalKnown: 5,
    });
    expect(r.rules[0]!.difference).toBeCloseTo(0.6);
  });

  it("only 3 outliers known can't be high, but can be medium", () => {
    const r = compareFeatures(many(3, { hook_type: "question" }), many(3, { hook_type: "other" }));
    expect(r.rules[0]).toMatchObject({ value: "question", confidence: "medium" });
  });

  it("medium: a difference of at least 40 points; 39 points is dropped", () => {
    // 3/5 vs 1/5 = 40 points.
    const outliers = [...many(3, { music: "none" }), ...many(2, { music: "ambient" })];
    const typical = [v({ music: "none" }), ...many(4, { music: "ambient" })];
    expect(
      compareFeatures(outliers, typical).rules.find((r) => r.feature === "music"),
    ).toMatchObject({
      value: "none",
      confidence: "medium",
    });
    // 3/4 vs 3/8 ... use 7/10-style shares: 2/3 vs 3/11 = 39.4 points: dropped.
    const o2 = [...many(2, { ending: "loop" }), v({ ending: "other" })];
    const t2 = [...many(3, { ending: "loop" }), ...many(8, { ending: "other" })];
    expect(compareFeatures(o2, t2).rules.find((r) => r.feature === "ending")).toBeUndefined();
  });

  it("drops a feature with fewer than 3 known values in either group; unknown never counts", () => {
    const outliers = [...many(2, { caption_style: "word_by_word" }), ...many(3, {})];
    const typical = many(5, { caption_style: "none" });
    const r = compareFeatures(outliers, typical);
    expect(r.rules.find((x) => x.feature === "caption_style")).toBeUndefined();
    const row = r.table.find((x) => x.feature === "caption_style" && x.value === "word_by_word")!;
    expect(row).toMatchObject({
      outliersWith: 2,
      outliersKnown: 2,
      typicalWith: 0,
      typicalKnown: 5,
    });
  });

  it("only patterns more common in outliers become rules", () => {
    const r = compareFeatures(many(5, { music: "ambient" }), many(5, { music: "none" }));
    expect(r.rules.map((x) => x.value)).toEqual(["ambient"]);
  });

  it("keeps one rule per feature, high before medium, then by difference, at most 5", () => {
    const strong: Partial<Record<FeatureName, string>> = {
      hook_type: "question",
      caption_style: "word_by_word",
      zoom_punch_ins: "frequent",
      music: "trending_or_upbeat",
      ending: "loop",
      face_in_first_shot: "yes",
    };
    const weak: Partial<Record<FeatureName, string>> = {
      hook_type: "other",
      caption_style: "none",
      zoom_punch_ins: "none",
      music: "none",
      ending: "abrupt",
      face_in_first_shot: "no",
    };
    const r = compareFeatures(many(5, strong), many(5, weak));
    expect(r.rules).toHaveLength(5);
    expect(new Set(r.rules.map((x) => x.feature)).size).toBe(5);
    expect(r.rules.every((x) => x.confidence === "high")).toBe(true);
    // Ties on difference fall back to feature name order, so the output is stable.
    expect(r.rules.map((x) => x.feature)).toEqual([
      "caption_style",
      "ending",
      "face_in_first_shot",
      "hook_type",
      "music",
    ]);
  });

  it("reports house style: a value shared by >= 80% of every compared video", () => {
    const r = compareFeatures(many(4, { length_bucket: "30_to_60s", hook_type: "question" }), [
      ...many(4, { length_bucket: "30_to_60s" }),
      v({ length_bucket: "over_60s" }),
    ]);
    expect(r.houseStyle).toContainEqual({
      feature: "length_bucket",
      value: "30_to_60s",
      with: 8,
      known: 9,
    });
    expect(r.rules.find((x) => x.feature === "length_bucket")).toBeUndefined();
  });

  it("finds topics most outliers share and few typical videos do, and warns", () => {
    const r = compareFeatures(
      [
        v({}, "My budget plan for 2026"),
        v({}, "Budget tips that work"),
        v({}, "The budget mistake"),
        v({}, "Morning routine"),
      ],
      [v({}, "Morning routine"), v({}, "Desk setup"), v({}, "Budget basics"), v({}, "Travel day")],
    );
    expect(r.outlierTopics).toEqual(["budget"]);
    expect(r.warnings.map((w) => w.code)).toEqual(["TOPIC_CONFOUND"]);
    // Same topic on both sides is not a confound.
    expect(
      compareFeatures(many(3, {}, "Morning routine"), many(3, {}, "Morning routine")).warnings,
    ).toEqual([]);
  });

  it("is deterministic whatever the input order", () => {
    const outliers = [...many(4, { hook_type: "question" }), v({ hook_type: "other" })];
    const typical = many(5, { hook_type: "bold_claim" });
    expect(compareFeatures([...outliers].reverse(), [...typical].reverse())).toEqual(
      compareFeatures(outliers, typical),
    );
  });
});

describe("titleWords", () => {
  it("drops stop words, filler, numbers and short words; merges plurals", () => {
    expect([...titleWords("How I made my BUDGETS in 2026 #shorts")].sort()).toEqual(["budget"]);
  });
  it("keeps words in other spaced scripts, with their vowel signs", () => {
    expect([...titleWords("बजट की योजना")]).toContain("योजना");
  });
  it("splits unspaced scripts into two-character pieces, so shared topics can match", () => {
    const a = titleWords("予算旅行のコツ");
    const b = titleWords("予算の話");
    expect([...a].some((w) => b.has(w))).toBe(true);
  });
  it("caps very long words", () => {
    expect([...titleWords(`super${"a".repeat(100)}`)][0]!.length).toBe(30);
  });
});

describe("compareFeatures review fixes", () => {
  it("a catch-all value never becomes a rule, but stays in the evidence table", () => {
    const r = compareFeatures(many(5, { hook_type: "other" }), many(5, { hook_type: "question" }));
    expect(r.rules.find((x) => x.feature === "hook_type")).toBeUndefined();
    expect(r.table.find((x) => x.value === "other")).toMatchObject({ outliersWith: 5 });
  });
  it("video type is context only", () => {
    const r = compareFeatures(
      many(5, { video_type: "talking head" }),
      many(5, { video_type: "montage" }),
    );
    expect(r.rules).toEqual([]);
  });
  it("medium needs at least 3 breakouts carrying the value", () => {
    // 2 of 3 vs 0 of 5: 67 points, but only 2 breakouts: noise.
    const r = compareFeatures(
      [...many(2, { music: "none" }), v({ music: "ambient" })],
      many(5, { music: "ambient" }),
    );
    expect(r.rules.find((x) => x.feature === "music")).toBeUndefined();
  });
  it("house style never repeats a rule", () => {
    const r = compareFeatures(many(8, { ending: "loop" }), many(3, { ending: "abrupt" }));
    expect(r.rules.map((x) => `${x.feature}=${x.value}`)).toContain("ending=loop");
    expect(r.houseStyle.find((h) => h.feature === "ending")).toBeUndefined();
  });
  it("a topic needs at least 3 breakouts sharing it", () => {
    const r = compareFeatures(
      [v({}, "Budget plan"), v({}, "Budget tips"), v({}, "Desk tour")],
      many(3, {}, "Travel day"),
    );
    expect(r.outlierTopics).toEqual([]);
  });
});
