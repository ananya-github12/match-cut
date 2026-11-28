/**
 * M10.10: the playbook eval runs offline, passes for all 10 golden channels (PRD-playbooks.md, M10
 * done-when), and actually catches a wrong playbook.
 */
import { loadManifest, modelNames, parseEnv } from "@match-cut/core";
import { MOCK_CHANNEL_SPECS, MockAnalyzer, MockChannelLookup } from "@match-cut/providers";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadPlaybookSet,
  passed,
  playbookReport,
  playbookReviewSheet,
  runPlaybookCase,
  runPlaybookSet,
  summarizePlaybooks,
  type PlaybookRunDeps,
} from "./playbooks.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const set = loadPlaybookSet(`${ROOT}playbooks`, "mock");
const now = () => Date.parse(set.as_of);
const deps = (): PlaybookRunDeps => ({
  analyzer: new MockAnalyzer(),
  channels: new MockChannelLookup({ now: () => new Date(now()) }),
  manifest: loadManifest(),
  models: modelNames(parseEnv({ DEV_API_TOKEN: "x", PROVIDER: "mock" })),
  now,
});
const sorted = (pairs: [string, string][]) => pairs.map((p) => p.join("=")).sort();
const loadedCase = (id: string) => set.loaded.find((c) => c.case.id === id)!;

describe("playbook golden set", () => {
  it("has 10 golden channels, each with a note, planted patterns matching the fixtures", () => {
    const golden = set.cases.filter((c) => c.id.startsWith("golden-"));
    expect(golden).toHaveLength(10);
    for (const c of golden) {
      expect(c.note.length, c.id).toBeGreaterThan(20);
      expect(c.source.type, c.id).toBe("mock");
      const handle = c.source.type === "mock" ? c.source.handle : "";
      const spec = MOCK_CHANNEL_SPECS.find((s) => s.handle === handle);
      expect(spec?.pattern, c.id).toBeDefined();
      // If a fixture's planted pattern changes, the eval's expectations must change with it.
      expect(sorted(c.expect.planted ?? []), c.id).toEqual(
        sorted(Object.entries(spec!.pattern!) as [string, string][]),
      );
    }
  });

  it("skips real channels until one is picked, and mock channels in a real run", () => {
    expect(set.loaded.filter((c) => c.skip).map((c) => c.case.id)).toEqual(["real-01", "real-02"]);
    const real = loadPlaybookSet(`${ROOT}playbooks`, "gemini");
    expect(real.loaded.every((c) => c.skip)).toBe(true);
  });

  it("every case passes in mock mode: faithful, planted patterns found, apply valid", async () => {
    const results = await runPlaybookSet(set, deps());
    const failures = results.filter((r) => !r.skipped && !passed(r));
    expect(failures.map((r) => `${r.id}: ${r.problems.join("; ")}`)).toEqual([]);
    const s = summarizePlaybooks(results);
    expect(s).toMatchObject({ ran: 16, skipped: 2, passed: 16, costUsd: 0 });
    expect(s.checks.faithful).toEqual({ applied: 13, passed: 13 });
    expect(s.checks.planted).toEqual({ applied: 10, passed: 10 });
    for (const r of results.filter((x) => x.id.startsWith("golden-"))) {
      expect(r.checks.apply, r.id).toBe(true);
      expect(r.applyPrompt, r.id).toContain(set.apply.goal);
      expect(r.shots, r.id).toBeGreaterThanOrEqual(4);
    }

    const report = playbookReport(
      {
        startedAt: "t",
        provider: "mock",
        targetSize: set.target_size,
        versions: { playbook: "pb1" },
      },
      s,
      results,
    );
    expect(report).toContain("**16 of 16 cases passed**");
    expect(report).toContain("Mock mode: no model cost.");
    expect(report).toContain("| planted | 10 of 10 |");
    expect(report).toContain("skipped: no channel picked yet");
    const sheet = playbookReviewSheet(results);
    expect(sheet).toContain("## golden-01");
    expect(sheet).toContain("| Correctness | Usefulness | Honesty | Originality | Comment |");
    expect(sheet).not.toContain("## real-01");
  }, 60_000);

  it("catches a playbook that misses its planted pattern", async () => {
    const golden = loadedCase("golden-01");
    const wrong = await runPlaybookCase(
      {
        case: {
          ...golden.case,
          expect: { outcome: "succeeded", planted: [["hook_type", "story_open"]] },
        },
      },
      set,
      deps(),
    );
    expect(wrong.checks.planted).toBe(false);
    expect(wrong.problems.join()).toContain("not found: hook_type=story_open");
    expect(passed(wrong)).toBe(false);
  });

  it("catches the wrong outcome, missing reasons and missing warnings", async () => {
    const tiny = loadedCase("edge-tiny");
    const badReason = await runPlaybookCase(
      { case: { ...tiny.case, expect: { outcome: "NOT_ENOUGH_DATA", reasons: ["NO_VIEWS"] } } },
      set,
      deps(),
    );
    expect(badReason.checks.outcome).toBe(false);
    expect(badReason.problems.join()).toContain("missing reasons NO_VIEWS");

    const mixed = loadedCase("edge-mixed");
    const badWarning = await runPlaybookCase(
      { case: { ...mixed.case, expect: { outcome: "succeeded", warnings: ["LIKES_HIDDEN"] } } },
      set,
      deps(),
    );
    expect(badWarning.checks.warnings).toBe(false);
    expect(badWarning.problems.join()).toContain("warnings: missing LIKES_HIDDEN");

    const badOutcome = await runPlaybookCase(
      { case: { ...mixed.case, expect: { outcome: "CHANNEL_NOT_FOUND" } } },
      set,
      deps(),
    );
    expect(badOutcome.checks.outcome).toBe(false);
    expect(badOutcome.problems.join()).toContain("expected CHANNEL_NOT_FOUND, got succeeded");
  });
});
