/**
 * M10.10: the playbook eval runs offline, passes for all 10 golden channels (PRD-playbooks.md, M10
 * done-when), and actually catches a wrong playbook.
 */
import { loadManifest, modelNames, parseEnv } from "@match-cut/core";
import type { PlaybookRecord } from "@match-cut/infra";
import { MOCK_CHANNEL_SPECS, MockAnalyzer, MockChannelLookup } from "@match-cut/providers";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildPlaybook,
  caseChannel,
  checkPlaybook,
  loadPlaybookSet,
  passed,
  playbookCaseSchema,
  playbookReport,
  playbookReviewSheet,
  runPlaybookCase,
  runPlaybookSet,
  summarizePlaybooks,
  type PlaybookCase,
  type PlaybookRunDeps,
} from "./playbooks.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const set = loadPlaybookSet(`${ROOT}playbooks`, "mock");
const now = () => Date.parse(set.as_of);
const deps = (over: Partial<PlaybookRunDeps> = {}): PlaybookRunDeps => ({
  analyzer: new MockAnalyzer(),
  channels: new MockChannelLookup({ now: () => new Date(now()) }),
  manifest: loadManifest(),
  models: modelNames(parseEnv({ DEV_API_TOKEN: "x", PROVIDER: "mock" })),
  now,
  ...over,
});
const sorted = (pairs: [string, string][]) => pairs.map((p) => p.join("=")).sort();
const caseById = (id: string) => set.cases.find((c) => c.id === id)!;
const runnable = set.loaded.filter((c) => !c.skip).map((c) => c.case);

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

  it("runs every mock case offline and skips only real channels", () => {
    expect(runnable.every((c) => c.source.type === "mock")).toBe(true);
    const skipped = set.loaded.filter((c) => c.skip);
    expect(skipped.every((c) => c.case.source.type === "channel")).toBe(true);
    // Mock channels never run against the real APIs.
    const real = loadPlaybookSet(`${ROOT}playbooks`, "gemini");
    expect(real.loaded.filter((c) => c.case.source.type === "mock").every((c) => c.skip)).toBe(
      true,
    );
  });

  it("every case passes in mock mode: faithful, planted patterns found, apply valid", async () => {
    const results = await runPlaybookSet(set, deps());
    const failures = results.filter((r) => !r.skipped && !passed(r));
    expect(failures.map((r) => `${r.id}: ${r.problems.join("; ")}`)).toEqual([]);
    const s = summarizePlaybooks(results);
    const succeeding = runnable.filter((c) => c.expect.outcome === "succeeded").length;
    const planted = runnable.filter((c) => c.expect.planted).length;
    expect(s).toMatchObject({
      ran: runnable.length,
      skipped: set.loaded.length - runnable.length,
      passed: runnable.length,
      costUsd: 0,
    });
    expect(s.checks.faithful).toEqual({ applied: succeeding, passed: succeeding });
    expect(s.checks.planted).toEqual({ applied: planted, passed: planted });
    // The done-when: every golden channel ran apply, and it passed.
    for (const r of results.filter((x) => x.id.startsWith("golden-"))) {
      expect(r.checks.faithful, r.id).toBe(true);
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
    expect(report).toContain(`**${runnable.length} of ${runnable.length} cases passed**`);
    expect(report).toContain("Mock mode: no model cost.");
    expect(report).toContain(`| planted | ${planted} of ${planted} |`);
    expect(report).toContain("skipped: no channel picked yet");
    const sheet = playbookReviewSheet(results);
    expect(sheet).toContain("## golden-01");
    expect(sheet).toContain("| Correctness | Usefulness | Honesty | Originality | Comment |");
    expect(sheet).not.toContain("## real-01");
  }, 60_000);
});

describe("the checks catch a wrong playbook", () => {
  const golden = caseById("golden-01");
  let pb: PlaybookRecord;
  beforeAll(async () => {
    pb = await buildPlaybook(golden, deps());
    expect(pb.status).toBe("succeeded");
    expect(pb.content!.rules.length).toBeGreaterThan(0);
  });
  const check = (tamper: (p: PlaybookRecord) => void, c: PlaybookCase = golden) => {
    const copy = structuredClone(pb);
    tamper(copy);
    return checkPlaybook(c, copy, set, deps());
  };

  it("passes the untouched playbook", async () => {
    const r = await check(() => {});
    expect(r.problems).toEqual([]);
    expect(passed(r)).toBe(true);
  });

  it("recounts evidence from the feature rows, even when the comparison agrees with it", async () => {
    const r = await check((p) => {
      p.content!.rules[0]!.evidence.outliers_with += 1;
      p.comparison!.rules[0]!.outliersWith += 1;
    });
    expect(r.checks.faithful).toBe(false);
    expect(r.problems.join()).toMatch(/rules\[0\] evidence .* recounted/);
  });

  it("catches evidence or confidence that differs from the comparison", async () => {
    const r = await check((p) => {
      const rule = p.content!.rules[0]!;
      rule.confidence = rule.confidence === "high" ? "medium" : "high";
    });
    expect(r.checks.faithful).toBe(false);
    expect(r.problems.join()).toContain("rules[0] evidence or confidence differs");
  });

  it("catches an example that isn't a breakout carrying the value", async () => {
    const typical = pb.comparison!.features.find((f) => f.group === "typical")!.videoId;
    const r = await check((p) => {
      const rule = p.content!.rules.find((x) => x.examples.length > 0)!;
      rule.examples[0]!.video_id = typical;
    });
    expect(r.checks.faithful).toBe(false);
    expect(r.problems.join()).toContain("is not a moment of a carrier");
  });

  it("catches feature rows that don't match the compared videos", async () => {
    const r = await check((p) => {
      const v = p.videos.find((x) => x.compared && x.group === "outlier")!;
      v.compared = false;
    });
    expect(r.checks.faithful).toBe(false);
    expect(r.problems.join()).toMatch(/isn't a compared outlier/);
  });

  it("catches a high-confidence rule that wasn't planted", async () => {
    const [first, second] = pb.content!.rules;
    const r = await check(
      (p) => {
        p.content!.rules[0]!.confidence = "high";
        p.comparison!.rules[0]!.confidence = "high";
      },
      { ...golden, expect: { outcome: "succeeded", planted: [[second!.feature, second!.value]] } },
    );
    expect(r.checks.faithful).toBe(true);
    expect(r.checks.planted).toBe(false);
    expect(r.problems.join()).toContain(
      `high-confidence rules not planted: ${first!.feature}=${first!.value}`,
    );
  });

  it("catches a missing planted pattern, outcome, reasons and warnings", async () => {
    const wrongPattern = await check(() => {}, {
      ...golden,
      expect: { outcome: "succeeded", planted: [["hook_type", "story_open"]] },
    });
    expect(wrongPattern.checks.planted).toBe(false);
    expect(wrongPattern.problems.join()).toContain("not found: hook_type=story_open");

    const wrongWarning = await check(() => {}, {
      ...golden,
      expect: { ...golden.expect, warnings: ["LIKES_HIDDEN"] },
    });
    expect(wrongWarning.checks.warnings).toBe(false);
    expect(wrongWarning.problems.join()).toContain("warnings: missing LIKES_HIDDEN");

    const tiny = caseById("edge-tiny");
    const tinyPb = await buildPlaybook(tiny, deps());
    const badReason = await checkPlaybook(
      { ...tiny, expect: { outcome: "NOT_ENOUGH_DATA", reasons: ["NO_VIEWS"] } },
      tinyPb,
      set,
      deps(),
    );
    expect(badReason.checks.outcome).toBe(false);
    expect(badReason.problems.join()).toContain("missing reasons NO_VIEWS");
    // A failed playbook can't pass a case that expects rules.
    const expectsRules = await checkPlaybook(golden, tinyPb, set, deps());
    expect(expectsRules.checks.planted).toBe(false);
    expect(expectsRules.problems.join()).toContain("expected succeeded, got NOT_ENOUGH_DATA");
  });

  it("fails apply when the model call fails", async () => {
    class ApplyDown extends MockAnalyzer {
      override async applyPlaybook(): Promise<never> {
        throw new Error("model unavailable");
      }
    }
    const r = await checkPlaybook(golden, pb, set, deps({ analyzer: new ApplyDown() }));
    expect(r.checks.apply).toBe(false);
    expect(r.problems).toContain("apply: model unavailable");
  });

  it("a case that crashes fails on its own", async () => {
    const r = await runPlaybookCase(
      { case: { ...golden, source: { type: "channel", channel: "not a channel" } } },
      set,
      deps(),
    );
    expect(r.status).toBe("crashed");
    expect(r.checks.outcome).toBe(false);
    expect(passed(r)).toBe(false);
  });
});

describe("cases file", () => {
  const golden = caseById("golden-01");
  it("requires golden cases to expect rules, and warnings only on success", () => {
    expect(
      playbookCaseSchema.safeParse({ ...golden, expect: { outcome: "succeeded" } }).success,
    ).toBe(false);
    expect(
      playbookCaseSchema.safeParse({
        ...caseById("edge-tiny"),
        expect: { outcome: "NOT_ENOUGH_DATA", warnings: ["LIKES_HIDDEN"] },
      }).success,
    ).toBe(false);
  });

  it("reads real channels the way the API does, and skips what isn't a channel", () => {
    const real = (channel: string): PlaybookCase => ({
      ...golden,
      id: "real-x",
      source: { type: "channel", channel },
      expect: { outcome: "succeeded" },
    });
    expect(caseChannel(real("@somecreator"))).toEqual({ kind: "handle", handle: "somecreator" });
    expect(caseChannel(real("UCabcdefghijklmnopqrstuv"))).toEqual({
      kind: "id",
      channelId: "UCabcdefghijklmnopqrstuv",
    });
    expect(caseChannel(real("https://www.youtube.com/@somecreator/shorts"))).toEqual({
      kind: "handle",
      handle: "somecreator",
    });
    expect(caseChannel(real("not a channel"))).toBeNull();

    const dir = mkdtempSync(join(tmpdir(), "mc-playbooks-"));
    writeFileSync(
      join(dir, "cases.json"),
      JSON.stringify({ ...set, cases: [real("not a channel"), real("@somecreator")] }),
    );
    const loaded = loadPlaybookSet(dir, "gemini").loaded;
    expect(loaded.map((c) => c.skip ?? null)).toEqual(["not a channel handle, ID or link", null]);
  });
});

describe("eval CLI (never passes --yes: nothing here can call a paid API)", () => {
  const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [tsx, "src/cli.ts", "--set", "playbooks", ...args], {
      cwd: ROOT,
      env: { ...process.env, GEMINI_API_KEY: "", YOUTUBE_DATA_API_KEY: "", ...env },
      encoding: "utf8",
      timeout: 60_000,
    });

  it("a real run needs both keys, then --yes", () => {
    const noKeys = cli(["--provider", "gemini"]);
    expect(noKeys.status).toBe(2);
    expect(noKeys.stderr).toContain("Set GEMINI_API_KEY and YOUTUBE_DATA_API_KEY");
    const noYes = cli(["--provider", "gemini"], {
      GEMINI_API_KEY: "not-a-key",
      YOUTUBE_DATA_API_KEY: "not-a-key",
    });
    expect(noYes.status).toBe(2);
    expect(noYes.stderr).toContain("Re-run with --yes");
  }, 60_000);

  it("--only must name a case, and --gate fails when nothing ran", () => {
    const typo = cli(["--only", "golden-99"]);
    expect(typo.status).toBe(2);
    expect(typo.stderr).toContain('No playbook case "golden-99"');
    const nothingRan = cli(["--only", "real-01", "--gate"]);
    expect(nothingRan.status).toBe(1);
    expect(nothingRan.stderr).toContain("Gate failed: no case ran.");
  }, 60_000);
});
