import { loadManifest, type Breakdown } from "@match-cut/core";
import { MockAnalyzer, MockVideoLookup } from "@match-cut/providers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockJudge } from "./judge.js";
import { gate, markdownReport, reviewSheet, toBaseline, type RunInfo } from "./report.js";
import { runSet, summarize } from "./run.js";
import {
  adaptationChecks,
  mapStepsToOperations,
  originality,
  promptSteps,
  specificity,
} from "./score.js";
import { loadSet, type EvalCase } from "./types.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const manifest = loadManifest();
const { spoken_lines_internal: _s, ...breakdown } = JSON.parse(
  readFileSync(
    new URL("../../packages/providers/fixtures/pass1/default.json", import.meta.url),
    "utf8",
  ),
) as Breakdown & { spoken_lines_internal: string[] };
const kase = (over: Partial<EvalCase> = {}): EvalCase => ({
  id: "t",
  url: "mockShort01",
  category: "talking-head short",
  goal: "A launch video for my budgeting app",
  target: { format: "9:16", length_seconds: 30 },
  language: "en",
  detail: "standard",
  status: "ready",
  ...over,
});
const models = { standard: "mock-flash", deep: "mock-pro", fallbacks: [], pass2: "mock-flash" };

describe("golden set", () => {
  it("has 10 cases, none of which run until a person writes the reference", () => {
    const { targetSize, cases } = loadSet(`${ROOT}golden`);
    expect(targetSize).toBe(50);
    expect(cases).toHaveLength(10);
    expect(cases.every((c) => c.skip)).toBe(true);
    expect(cases.filter((c) => c.skip === "needs a human-written reference")).toHaveLength(5);
    expect(cases.filter((c) => c.skip === "no video yet")).toHaveLength(5);
  });
});

describe("scorers", () => {
  it("specificity counts distinct numeric details", () => {
    const s = specificity(breakdown);
    expect(s.count).toBeGreaterThanOrEqual(6);
    expect(s.examples).toContain("90 bpm");
  });

  it("originality catches copied speech and brand terms", () => {
    const line = "stop doing this one thing every single morning because it ruins your whole week";
    expect(originality(`intro ${line}`, [line], null)).toMatchObject({
      pass: false,
      sharedRun: 14,
    });
    expect(
      originality("Mention AcmeCo here", [], { brand_terms: ["AcmeCo"] } as never),
    ).toMatchObject({
      pass: false,
      brandHits: ["AcmeCo"],
    });
    expect(originality("all original", [line], null).pass).toBe(true);
  });

  it("adaptation needs the goal, reframing for a new format, and condensing for a shorter target", () => {
    const ok =
      "1. Rough cut for my budgeting launch. 2. Reframe to 16:9. 3. Keep the hook, merge the middle to fit 0:15.";
    expect(
      adaptationChecks(ok, kase({ target: { format: "16:9", length_seconds: 15 } }), breakdown)
        .pass,
    ).toBe(true);
    const bad = adaptationChecks(
      "1. Cut it.",
      kase({ target: { format: "16:9", length_seconds: 15 } }),
      breakdown,
    );
    expect(bad.failed).toEqual([
      "the prompt doesn't reflect the goal",
      "no reframing step for 9:16 -> 16:9",
      "no condensing step for a shorter target",
    ]);
  });

  it("maps numbered steps to manifest operations", () => {
    const steps = mapStepsToOperations(
      "1. Add word-by-word captions.\n2. Teleport the viewer.\n3. Apply a warm grade.",
      manifest,
    );
    expect(steps.map((s) => s.operation)).toEqual(["captions", null, "lut"]);
    expect(promptSteps("intro\n1. a\n2) b")).toEqual([
      { step: 1, text: "a" },
      { step: 2, text: "b" },
    ]);
  });
});

describe("runner, judge, report and gate (smoke set, mock mode)", () => {
  const info: RunInfo = {
    set: "smoke",
    startedAt: "2026-11-17T00:00:00.000Z",
    provider: "mock",
    judge: "mock",
    models: { standard: "mock-flash", deep: "mock-pro", pass2: "mock-flash" },
    versions: { pass1: "p1.v1", pass2: "p2.v2", schema: "s1", manifest: "0" },
    targetSize: 3,
  };

  it("runs every smoke case through both passes and scores all six criteria", async () => {
    const { cases } = loadSet(`${ROOT}smoke`);
    const results = await runSet(cases, {
      analyzer: new MockAnalyzer(),
      judge: new MockJudge(),
      manifest,
      models,
      lookup: new MockVideoLookup(),
    });
    expect(results.map((r) => r.status)).toEqual(["scored", "scored", "scored"]);
    const tutorial = results.find((r) => r.id === "mock-tutorial")!;
    // Regression: the tutorial must be scored on its own breakdown, not the default fixture.
    expect(JSON.stringify(tutorial.breakdown)).toContain("screen-recording tutorial");
    expect(tutorial.criteria!.honesty.pass).toBe(true);

    const summary = summarize(results);
    expect(summary.criteria.executability.passRate).toBe(1);
    expect(summary.criteria.originality.meetsBar).toBe(true);
    expect(summary.criteria.honesty.meetsBar).toBeNull(); // reviewer spot-check

    const md = markdownReport(info, summary, results, gate(summary, toBaseline(info, summary)));
    expect(md).toContain("**Gate: pass**");
    expect(md).toContain("| executability | 100% of 3 |");
    const review = reviewSheet(results, 10, () => 0.5);
    expect(review).toContain("# Human review");
  });

  it("the gate fails any criterion that drops below the baseline", () => {
    const base = {
      set: "s",
      createdAt: "",
      versions: info.versions,
      models: info.models,
      criteria: { adaptation: { passRate: 1 }, accuracy: { passRate: 1, aggregate: 0.01 } },
    };
    const now = {
      cases: 3,
      scored: 3,
      skipped: 0,
      errors: 0,
      costUsd: 0,
      criteria: {
        accuracy: { passRate: 1, scored: 3, meetsBar: true, aggregate: 0.04 },
        specificity: { passRate: 1, scored: 3, meetsBar: true },
        executability: { passRate: 1, scored: 3, meetsBar: true },
        adaptation: { passRate: 2 / 3, scored: 3, meetsBar: false },
        originality: { passRate: 1, scored: 3, meetsBar: true },
        honesty: { passRate: 0, scored: 3, meetsBar: null },
      },
    };
    expect(gate(now, base)).toEqual({
      ok: false,
      regressions: ["adaptation: 67% < baseline 100%", "accuracy wrong rate: 4% > baseline 1%"],
    });
    expect(gate(now, null).ok).toBe(true);
  });
});
