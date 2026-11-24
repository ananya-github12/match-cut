/**
 * Playbook comparison: which edit features separate a channel's breakouts from its typical
 * Shorts. PRD-playbooks.md, Feature 3 > "Comparison (deterministic code)". Pure and
 * deterministic: every count here is what the playbook will show as evidence, so the model never
 * writes a number.
 */
import { playbookWarning, type PlaybookWarning } from "../errors.js";
import {
  CATCH_ALL_VALUES,
  CONTEXT_ONLY_FEATURES,
  FEATURE_NAMES,
  UNKNOWN,
  type FeatureName,
  type FeatureRow,
} from "./features.js";

export interface ComparedVideo {
  videoId: string;
  /** Owner-written title: only tokenized and counted here, never interpreted. */
  title: string;
  features: FeatureRow;
}

export interface FeatureCount {
  feature: FeatureName;
  value: string;
  outliersWith: number;
  /** Outliers whose value for this feature is known (not "unknown"). */
  outliersKnown: number;
  typicalWith: number;
  typicalKnown: number;
}

export type Confidence = "high" | "medium";

export interface CandidateRule extends FeatureCount {
  confidence: Confidence;
  /** Share among outliers minus share among typical videos, 0 to 1. */
  difference: number;
}

export interface HouseStyle {
  feature: FeatureName;
  value: string;
  /** Videos with this value, of those where the feature is known. */
  with: number;
  known: number;
}

export interface ComparisonResult {
  /** Every feature value seen, with its counts: the playbook's evidence table. */
  table: FeatureCount[];
  /** Kept patterns, strongest first, at most one per feature; never a catch-all value. */
  rules: CandidateRule[];
  houseStyle: HouseStyle[];
  /** Title words shared by most outliers and few typical videos (owner text: data only). */
  outlierTopics: string[];
  warnings: PlaybookWarning[];
}

/** A share as an exact fraction [numerator, denominator], compared in integers. */
export type Fraction = readonly [number, number];
const atLeast = (part: number, whole: number, [n, d]: Fraction) => part * d >= n * whole;
const atMost = (part: number, whole: number, [n, d]: Fraction) => part * d <= n * whole;

/** PRD confidence rules. */
export const HIGH_OUTLIER_SHARE: Fraction = [4, 5];
export const HIGH_TYPICAL_SHARE: Fraction = [3, 10];
export const HIGH_MIN_OUTLIERS_KNOWN = 4;
export const MEDIUM_DIFFERENCE: Fraction = [2, 5];
export const MIN_KNOWN_PER_GROUP = 3;
export const MAX_RULES = 5;
/** House style: a value at least this common across every compared video. */
export const HOUSE_STYLE_SHARE: Fraction = [4, 5];
export const HOUSE_STYLE_MIN_KNOWN = 5;
/** Topic confound: a title word in at least 60% of outliers and at most 30% of typical videos. */
export const TOPIC_OUTLIER_SHARE: Fraction = [3, 5];
export const TOPIC_TYPICAL_SHARE: Fraction = [3, 10];
/** ...and in at least this many outliers, so one or two titles can't raise the warning. */
export const MIN_TOPIC_OUTLIERS = 3;

const known = (v: string | undefined) => v !== undefined && v !== UNKNOWN && v !== "";

/**
 * Stop words: function words plus title filler that says nothing about the topic. English only;
 * for other scripts the topic check is weaker (see titleWords).
 */
const STOP = new Set(
  (
    "a an and are as at be but by can for from get got how i in is it its just me more most my " +
    "new now of on or our out so than that the their this to top try up was we what when why " +
    "will with you your best make made makes making day days thing things way ways part episode " +
    "shorts short video videos vs tip"
  ).split(" "),
);

/** Scripts written without spaces: compared as two-character pieces instead of words. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
/** Longest topic word kept (titles are owner text that later reaches a prompt). */
export const MAX_TOPIC_CHARS = 30;

/** A crude singular: "budgets" and "budget" count as one topic. */
function singular(w: string): string {
  return w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

export function titleWords(title: string): Set<string> {
  const out = new Set<string>();
  for (const raw of title
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{M}\p{N}']+/u)) {
    const w = raw.replace(/^'+|'+$/g, "");
    if (!w || /^\d+$/.test(w)) continue;
    if (UNSPACED.test(w)) {
      const chars = [...w];
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i]! + chars[i + 1]!);
      continue;
    }
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(singular(w).slice(0, MAX_TOPIC_CHARS));
  }
  return out;
}

/**
 * The PRD's thresholds, checked in exact integer arithmetic (a share like 3/5 - 1/5 is
 * 0.39999... in floating point, which would drop a pattern sitting exactly on 40 points).
 */
function confidenceOf(c: FeatureCount): CandidateRule | null {
  const { outliersWith: ow, outliersKnown: ok, typicalWith: tw, typicalKnown: tk } = c;
  if (ok < MIN_KNOWN_PER_GROUP || tk < MIN_KNOWN_PER_GROUP) return null;
  const difference = ow / ok - tw / tk;
  if (
    atLeast(ow, ok, HIGH_OUTLIER_SHARE) &&
    atMost(tw, tk, HIGH_TYPICAL_SHARE) &&
    ok >= HIGH_MIN_OUTLIERS_KNOWN
  ) {
    return { ...c, confidence: "high", difference };
  }
  // ow/ok - tw/tk >= n/d  <=>  (ow*tk - tw*ok) * d >= n * ok * tk. Stricter than the PRD
  // draft: at least 3 breakouts must carry the value, or 2-of-3 noise becomes a rule.
  if (ow >= MIN_KNOWN_PER_GROUP && atLeast(ow * tk - tw * ok, ok * tk, MEDIUM_DIFFERENCE)) {
    return { ...c, confidence: "medium", difference };
  }
  return null;
}

/** Plain code-unit order: the same on every machine, unlike localeCompare. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byValue = (a: { feature: string; value: string }, b: { feature: string; value: string }) =>
  cmp(a.feature, b.feature) || cmp(a.value, b.value);

export function compareFeatures(
  outliers: ComparedVideo[],
  typical: ComparedVideo[],
): ComparisonResult {
  const table: FeatureCount[] = [];
  for (const feature of FEATURE_NAMES) {
    const oKnown = outliers.filter((v) => known(v.features[feature]));
    const tKnown = typical.filter((v) => known(v.features[feature]));
    const values = new Set([...oKnown, ...tKnown].map((v) => v.features[feature]!));
    for (const value of values) {
      table.push({
        feature,
        value,
        outliersWith: oKnown.filter((v) => v.features[feature] === value).length,
        outliersKnown: oKnown.length,
        typicalWith: tKnown.filter((v) => v.features[feature] === value).length,
        typicalKnown: tKnown.length,
      });
    }
  }
  table.sort(byValue);

  // Strongest value per feature only, so the playbook never says two things about one feature.
  const best = new Map<FeatureName, CandidateRule>();
  for (const c of table) {
    // "Use an 'other' hook" isn't advice, and free-text video types are context only.
    if (CATCH_ALL_VALUES.has(c.value) || CONTEXT_ONLY_FEATURES.has(c.feature)) continue;
    const rule = confidenceOf(c);
    if (!rule) continue;
    const prev = best.get(c.feature);
    const rank = (r: CandidateRule) => (r.confidence === "high" ? 1 : 0);
    if (
      !prev ||
      rank(rule) > rank(prev) ||
      (rank(rule) === rank(prev) && rule.difference > prev.difference)
    ) {
      best.set(c.feature, rule);
    }
  }
  const rules = [...best.values()]
    .sort(
      (a, b) =>
        (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1) ||
        b.difference - a.difference ||
        byValue(a, b),
    )
    .slice(0, MAX_RULES);

  // House style: what nearly every compared video does, so users don't mistake it for the secret.
  // Among the compared videos only, and never a value that is also a rule.
  const everyone = [...outliers, ...typical];
  const isRule = (feature: FeatureName, value: string) =>
    rules.some((r) => r.feature === feature && r.value === value);
  const houseStyle: HouseStyle[] = [];
  for (const feature of FEATURE_NAMES) {
    const k = everyone.filter((v) => known(v.features[feature]));
    if (k.length < HOUSE_STYLE_MIN_KNOWN) continue;
    const counts = new Map<string, number>();
    for (const v of k)
      counts.set(v.features[feature]!, (counts.get(v.features[feature]!) ?? 0) + 1);
    for (const [value, n] of counts) {
      if (atLeast(n, k.length, HOUSE_STYLE_SHARE) && !isRule(feature, value)) {
        houseStyle.push({ feature, value, with: n, known: k.length });
      }
    }
  }
  houseStyle.sort(byValue);

  // Topics the outliers share: a sign the topic, not the edit, may explain them.
  const oWords = outliers.map((v) => titleWords(v.title));
  const tWords = typical.map((v) => titleWords(v.title));
  const candidates = new Set(oWords.flatMap((s) => [...s]));
  const outlierTopics = [...candidates]
    .filter((w) => {
      const o = oWords.filter((s) => s.has(w)).length;
      const t = tWords.filter((s) => s.has(w)).length;
      return (
        o >= MIN_TOPIC_OUTLIERS &&
        atLeast(o, oWords.length, TOPIC_OUTLIER_SHARE) &&
        atMost(t, Math.max(1, tWords.length), TOPIC_TYPICAL_SHARE)
      );
    })
    .sort();

  const warnings: PlaybookWarning[] = outlierTopics.length
    ? [playbookWarning("TOPIC_CONFOUND")]
    : [];
  return { table, rules, houseStyle, outlierTopics, warnings };
}
