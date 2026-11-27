/** M10.5: playbook and skill storage, serializers and skill snapshots (PRD-playbooks.md). */
import {
  createPlaybookRequestSchema,
  createSkillRequestSchema,
  PLAYBOOK_STAGES,
  SKILL_NAME_MAX_CHARS,
} from "@match-cut/core";
import {
  MemoryPlaybookStore,
  MemorySkillStore,
  skillFromBrief,
  skillFromPlaybook,
  toPlaybookResponse,
  toSkillResponse,
  toSkillSummary,
} from "@match-cut/infra";
import { describe, expect, it } from "vitest";
import {
  briefRecord,
  fixtureBreakdown,
  playbookRecord,
  RULE,
  skillRecord,
  storeContract,
} from "./playbook-fixtures.js";

storeContract("memory", () => ({
  playbooks: new MemoryPlaybookStore(),
  skills: new MemorySkillStore(),
}));

describe("toPlaybookResponse (PRD-playbooks.md, Playbook object)", () => {
  it("maps a finished playbook to the PRD's fields", () => {
    const r = toPlaybookResponse(playbookRecord());
    expect(r).toMatchObject({
      status: "succeeded",
      stage: null,
      progress: null,
      channel: {
        id: "UCmockgolden01xxxxxxxxxx",
        title: "Mock Golden 01",
        handle: "mockgolden01",
        subscriber_count_rounded: 12300,
        subscriber_count_hidden: false,
      },
      window: { uploads_seen: 4, shorts_eligible: 2, too_new: 1 },
      baseline: { median_views: 1000, median_engagement_rate: 0.05 },
      rules: [RULE],
      recipe_prompt_template: expect.stringContaining("{{GOAL}}"),
      meta: { cost_usd: 0.01, cached: false, created_at: "2026-11-20T10:00:00.000Z" },
    });
    expect(Object.keys(r.window!)).toEqual([
      "from",
      "to",
      "uploads_seen",
      "shorts_eligible",
      "too_new",
    ]);
  });

  it("lists Shorts only; too-new uploads are 'other' with no score", () => {
    const videos = toPlaybookResponse(playbookRecord()).videos;
    expect(videos.map((v) => [v.id, v.group, v.outlier_score])).toEqual([
      ["mgold01v000001", "outlier", 5],
      ["mgold01v000002", "typical", 1],
      ["mgold01v000003", "other", null],
    ]);
    expect(videos[0]).toMatchObject({ brief_id: "brf_1", likes: 100, comments: 10 });
    expect(videos[1]!.likes).toBeNull();
  });

  it("never exposes internals", () => {
    const json = JSON.stringify(toPlaybookResponse(playbookRecord()));
    for (const hidden of [
      "a line someone said",
      "spokenLines",
      "spoken_lines",
      "source",
      "outlierTopics",
      '"table"',
      "settings",
      "notShort",
      'engagement_rate":0.02',
    ]) {
      expect(json, hidden).not.toContain(hidden);
    }
  });

  it("shows stage and watching progress only while running", () => {
    const running = toPlaybookResponse(
      playbookRecord({
        status: "processing",
        stage: "watching",
        progress: { done: 3, total: 10 },
        content: null,
      }),
    );
    expect(running).toMatchObject({
      stage: "watching",
      progress: { done: 3, total: 10 },
      rules: null,
    });
    const comparing = toPlaybookResponse(
      playbookRecord({
        status: "processing",
        stage: "comparing",
        progress: { done: 10, total: 10 },
      }),
    );
    expect(comparing.progress).toBeNull();
    const failed = toPlaybookResponse(
      playbookRecord({
        status: "failed",
        stage: "scoring",
        channel: null,
        window: null,
        baseline: null,
        videos: [],
        content: null,
        error: { code: "NOT_ENOUGH_DATA", message: "m", retryable: false },
      }),
    );
    expect(failed).toMatchObject({
      stage: null,
      channel: null,
      window: null,
      rules: null,
      error: { code: "NOT_ENOUGH_DATA" },
    });
  });
});

describe("skill snapshots (PRD-playbooks.md, Feature 4)", () => {
  it("from a finished playbook: rules, recipe, channel and versions, no view counts", () => {
    const draft = skillFromPlaybook(playbookRecord());
    if (typeof draft === "string") throw new Error(draft);
    expect(draft.sourceTitle).toBe("Mock Golden 01");
    expect(draft.snapshot).toMatchObject({
      type: "playbook",
      rules: [RULE],
      channel: { id: "UCmockgolden01xxxxxxxxxx", handle: "mockgolden01" },
      spokenLines: ["a line someone said in a breakout video"],
    });
    expect(draft.versions).toMatchObject({ features: "f1", comparison: "c1", playbook: "pb1" });
    expect(JSON.stringify(draft)).not.toMatch(/"views"|"likes"|medianViews/);
  });

  it("refuses an unfinished playbook or one without rules", () => {
    expect(skillFromPlaybook(playbookRecord({ status: "processing" }))).toBe("NOT_READY");
    expect(skillFromPlaybook(playbookRecord({ status: "failed", content: null }))).toBe(
      "NOT_READY",
    );
    const empty = playbookRecord();
    empty.content!.rules = [];
    expect(skillFromPlaybook(empty)).toBe("NO_RULES");
  });

  it("from a brief with a breakdown, partial included", () => {
    for (const status of ["succeeded", "partial"] as const) {
      const draft = skillFromBrief(briefRecord({ status }));
      if (typeof draft === "string") throw new Error(draft);
      expect(draft.snapshot).toEqual({
        type: "brief",
        videoId: "dQw4w9WgXcQ",
        videoTitle: "A reference",
        breakdown: fixtureBreakdown,
        spokenLines: ["spoken"],
      });
      expect(JSON.stringify(draft)).not.toContain("secret goal");
    }
    expect(skillFromBrief(briefRecord({ status: "processing" }))).toBe("NOT_READY");
    expect(skillFromBrief(briefRecord({ status: "failed", breakdown: null }))).toBe("NOT_READY");
  });

  it("serializes skills without spoken lines", () => {
    const rec = skillRecord({ lastUsedAt: new Date("2026-11-22T00:00:00Z") });
    expect(toSkillSummary(rec)).toEqual({
      id: rec.id,
      name: "Question hooks",
      source: { type: "playbook", id: "pb_1", title: "Mock Golden 01" },
      last_used_at: "2026-11-22T00:00:00.000Z",
      created_at: "2026-11-21T10:00:00.000Z",
      updated_at: "2026-11-21T10:00:00.000Z",
    });
    const full = toSkillResponse(rec);
    expect(full.snapshot).toMatchObject({
      type: "playbook",
      rules: [RULE],
      recipe_prompt_template: null,
    });
    expect(JSON.stringify(full)).not.toContain("internal");
    const brief = toSkillResponse(
      skillRecord({
        source: { type: "brief", id: "brf_1" },
        snapshot: {
          type: "brief",
          videoId: "dQw4w9WgXcQ",
          videoTitle: null,
          breakdown: fixtureBreakdown,
          spokenLines: ["internal"],
        },
      }),
    );
    expect(brief.snapshot).toEqual({
      type: "brief",
      video_id: "dQw4w9WgXcQ",
      video_title: null,
      breakdown: fixtureBreakdown,
    });
    expect(JSON.stringify(brief)).not.toContain("internal");
  });
});

describe("request schemas (PRD-playbooks.md, API additions)", () => {
  it("POST /v1/playbooks: defaults and ranges from the PRD", () => {
    expect(createPlaybookRequestSchema.parse({ source: { channel: "@mockgolden01" } })).toEqual({
      source: { channel: "@mockgolden01" },
      window_days: 90,
      max_videos: 50,
      outlier_threshold: 2,
      force_refresh: false,
    });
    for (const bad of [
      { source: { channel: "" } },
      { source: { channel: "x".repeat(2049) } },
      { source: { channel: "@a" }, window_days: 29 },
      { source: { channel: "@a" }, window_days: 181 },
      { source: { channel: "@a" }, max_videos: 9 },
      { source: { channel: "@a" }, outlier_threshold: 1.4 },
      { source: { channel: "@a" }, outlier_threshold: 10.5 },
      { source: { channel: "@a" }, extra: 1 },
      { source: { mine: true } },
      {},
    ]) {
      expect(createPlaybookRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("POST /v1/skills: a trimmed name and exactly one source", () => {
    expect(
      createSkillRequestSchema.parse({ name: "  My   hooks ", source: { playbook_id: "pb_1" } }),
    ).toEqual({
      name: "My hooks",
      source: { playbook_id: "pb_1" },
    });
    for (const bad of [
      { name: "   ", source: { brief_id: "b" } },
      { name: "x".repeat(SKILL_NAME_MAX_CHARS + 1), source: { brief_id: "b" } },
      { name: "ok", source: { brief_id: "b", playbook_id: "p" } },
      { name: "ok", source: {} },
      { name: "ok" },
    ]) {
      expect(createSkillRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("stages are the PRD's, in order", () => {
    expect(PLAYBOOK_STAGES).toEqual([
      "resolving_channel",
      "fetching_stats",
      "scoring",
      "watching",
      "extracting",
      "comparing",
      "writing_playbook",
      "validating",
    ]);
  });
});
