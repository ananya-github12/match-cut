/**
 * The offline playbook writer (PROVIDER=mock) must always produce a playbook that passes every
 * check, for any number of rules and any feature, so the whole flow runs without API keys.
 */
import {
  checkPlaybook,
  countWords,
  FEATURE_NAMES,
  faithfulnessProblems,
  GOAL_SLOT,
  RECIPE_MAX_WORDS,
  RECIPE_MIN_WORDS,
  type Breakdown,
  type CandidateRule,
  type FeatureName,
  type FeatureRow,
  type PlaybookFacts,
} from "@match-cut/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mockPlaybook } from "./mock.js";

const { spoken_lines_internal: spokenLines, ...breakdown } = JSON.parse(
  readFileSync(new URL("../../fixtures/pass1/default.json", import.meta.url), "utf8"),
) as Breakdown & { spoken_lines_internal: string[] };

// Moment features and whole-video features, with values that have fallback copy.
const PLANTED: [FeatureName, string][] = [
  ["hook_type", "question"],
  ["caption_style", "word_by_word"],
  ["zoom_punch_ins", "frequent"],
  ["music", "trending_or_upbeat"],
  ["ending", "loop"],
];

function factsWith(count: number): PlaybookFacts {
  const planted = PLANTED.slice(0, count);
  const row = (carries: boolean) =>
    ({
      ...Object.fromEntries(FEATURE_NAMES.map((f) => [f, "unknown"])),
      ...Object.fromEntries(planted.map(([f, v]) => [f, carries ? v : "none"])),
    }) as FeatureRow;
  const outliers = [0, 1, 2, 3, 4].map((i) => ({
    videoId: `mockvid0000${i}`,
    analyzedSeconds: 60,
    features: row(i < 4),
    breakdown,
    spokenLines,
  }));
  const rules: CandidateRule[] = planted.map(([feature, value]) => ({
    feature,
    value,
    outliersWith: 4,
    outliersKnown: 5,
    typicalWith: 0,
    typicalKnown: 5,
    confidence: "high",
    difference: 0.8,
  }));
  return { rules, houseStyle: [], outlierTopics: [], outliers, avoidNames: ["Mock Channel"] };
}

describe("mockPlaybook", () => {
  it.each([1, 2, 3, 4, 5])("with %i rules passes every check", (count) => {
    const facts = factsWith(count);
    const out = mockPlaybook(facts);
    const r = checkPlaybook(out, facts);
    expect(r.problems).toEqual([]);
    expect(faithfulnessProblems(r.content, facts)).toEqual([]);
    const words = countWords(out.recipe_prompt_template.replace(GOAL_SLOT, " "));
    expect(words).toBeGreaterThanOrEqual(RECIPE_MIN_WORDS);
    expect(words).toBeLessThanOrEqual(RECIPE_MAX_WORDS);
    // Every rule cites a moment, whole-video features included.
    for (const rule of r.content.rules) expect(rule.examples.length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    expect(mockPlaybook(factsWith(3))).toEqual(mockPlaybook(factsWith(3)));
  });
});
