/**
 * M10: channel data and scoring together, on the offline channels. PRD-playbooks.md, Feature 3.
 */
import {
  checkFeatures,
  checkPass2,
  checkPlaybook,
  compareFeatures,
  faithfulnessProblems,
  featureRow,
  GOAL_SLOT,
  groundFeatures,
  loadManifest,
  parseTimecode,
  scoreChannel,
  type Breakdown,
  type ComparedVideo,
  type PlaybookFacts,
  type ScoredVideo,
  type ScoringResult,
} from "@match-cut/core";
import {
  GOLDEN_CHANNEL_HANDLES,
  MOCK_CHANNEL_SPECS,
  MockAnalyzer,
  MockChannelLookup,
} from "@match-cut/providers";
import { readFileSync } from "node:fs";
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

const { spoken_lines_internal: spokenLines, ...breakdown } = JSON.parse(
  readFileSync(
    new URL("../packages/providers/fixtures/pass1/default.json", import.meta.url),
    "utf8",
  ),
) as Breakdown & { spoken_lines_internal: string[] };

async function compared(videos: ScoredVideo[]): Promise<ComparedVideo[]> {
  const analyzer = new MockAnalyzer();
  return Promise.all(
    videos.map(async (v) => {
      const r = await analyzer.extractFeatures({ videoId: v.id, breakdown, model: "mock" });
      const check = checkFeatures(r.output);
      if (!check.output) throw new Error(check.problems.join("; "));
      const { values, ungrounded } = groundFeatures(check.output, breakdown);
      expect(ungrounded).toEqual([]);
      return {
        videoId: v.id,
        title: v.title,
        features: featureRow(values, breakdown, v.durationSeconds),
      };
    }),
  );
}

describe("scoring + features + comparison recover each golden channel's planted pattern", () => {
  it.each(GOLDEN_CHANNEL_HANDLES)("%s", async (handle) => {
    const spec = MOCK_CHANNEL_SPECS.find((x) => x.handle === handle)!;
    const r = await score(handle);
    if (!r.ok) throw new Error("not enough data");
    const result = compareFeatures(await compared(r.outliers), await compared(r.typical));
    const picked = r.outliers.map((v) => Number(v.id.slice(-6)));
    const counterexampleAt = spec.counterexample
      ? Math.max(
          ...Object.entries(spec.outliers)
            .filter(([, m]) => m >= 2)
            .map(([i]) => Number(i)),
        )
      : -1;
    const planted = Object.entries(spec.pattern!);
    for (const [k, [feature, value]] of planted.entries()) {
      const rule = result.rules.find((x) => x.feature === feature);
      expect(rule, `${handle}: ${feature}=${value}`).toMatchObject({ value });
      // Exact evidence: planted breakouts always carry the value (no "unknown"), except the
      // channel's one counterexample on its first pattern feature; typical videos never do.
      const breaking = k === 0 && picked.includes(counterexampleAt) ? 1 : 0;
      expect(rule).toMatchObject({
        outliersKnown: r.outliers.length,
        outliersWith: r.outliers.length - breaking,
        typicalWith: 0,
      });
      const expected = r.outliers.length >= 4 && rule!.outliersWith / r.outliers.length >= 0.8;
      expect(rule!.confidence).toBe(expected ? "high" : "medium");
    }
    // Nothing but a planted pattern reaches high confidence; noise stays out of the top.
    const plantedKeys = new Set(planted.map(([f, v]) => `${f}=${v}`));
    for (const rule of result.rules.filter((x) => x.confidence === "high")) {
      expect(plantedKeys.has(`${rule.feature}=${rule.value}`), `${handle}: ${rule.feature}`).toBe(
        true,
      );
    }
    // Planted high-confidence rules rank ahead of every other rule. (A medium planted rule can
    // tie with 3-of-4 noise on a small sample; SMALL_SAMPLE warns about exactly that.)
    const firstOther = result.rules.findIndex((x) => !plantedKeys.has(`${x.feature}=${x.value}`));
    const highPlanted = result.rules.filter((x) => x.confidence === "high").length;
    if (firstOther !== -1) expect(firstOther).toBeGreaterThanOrEqual(highPlanted);
    // Every video compares as the same mock breakdown: the edit's pace is house style.
    expect(result.houseStyle.map((h) => h.feature)).toContain("avg_shot_length_bucket");
  });

  it("the topic channel warns that the topic may explain the breakouts", async () => {
    const r = await score("mockgolden02");
    if (!r.ok) throw new Error();
    const result = compareFeatures(await compared(r.outliers), await compared(r.typical));
    expect(result.outlierTopics).toContain("budget");
    expect(result.warnings.map((w) => w.code)).toContain("TOPIC_CONFOUND");
  });
});

describe("playbook writing on every golden channel (M10 done-when: faithful playbooks)", () => {
  it.each(GOLDEN_CHANNEL_HANDLES)("%s", async (handle) => {
    const r = await score(handle);
    if (!r.ok) throw new Error("not enough data");
    const outliers = await compared(r.outliers);
    const result = compareFeatures(outliers, await compared(r.typical));
    const facts: PlaybookFacts = {
      rules: result.rules,
      houseStyle: result.houseStyle,
      outlierTopics: result.outlierTopics,
      outliers: outliers.map((o) => ({
        videoId: o.videoId,
        analyzedSeconds: parseTimecode(breakdown.format.duration)!,
        features: o.features,
        breakdown,
        spokenLines,
      })),
      avoidNames: [handle],
    };
    const written = await new MockAnalyzer().writePlaybook({
      facts,
      manifest: loadManifest(),
      language: "en",
      model: "mock",
    });
    const check = checkPlaybook(written.output, facts);
    expect(check.problems).toEqual([]);
    expect(faithfulnessProblems(check.content, facts)).toEqual([]);
    expect(check.content.rules.length).toBe(result.rules.length);
    for (const rule of check.content.rules) expect(rule.examples.length).toBeGreaterThan(0);
    // The channel with a counterexample shows it on its first planted rule.
    const spec = MOCK_CHANNEL_SPECS.find((x) => x.handle === handle)!;
    const first = check.content.rules.find(
      (x) => x.feature === Object.values(spec.pattern!)[0]![0],
    );
    if (first && first.evidence.outliers_with < first.evidence.outliers_known) {
      expect(first.counterexample).not.toBeNull();
    }
    // The recipe, filled with a goal, passes v1's prompt checks.
    const recipe = check.content.recipe_prompt_template!;
    const filled = recipe.replace(GOAL_SLOT, "a 30-second video about my coffee cart");
    const v1 = checkPass2(
      { cardboard_prompt: filled, assets_needed: [], watch_outs: ["-"], shot_list: [] },
      { spokenLines, language: "en" },
    );
    expect(v1.problems.filter((p) => !v1.shotListProblems.includes(p))).toEqual([]);
  });
});
