/** Shared builders and the store contract for playbook and skill storage (M10.5). */
import type { Breakdown, PlaybookRule } from "@match-cut/core";
import type {
  BriefRecord,
  PlaybookRecord,
  PlaybookStore,
  SkillRecord,
  SkillStore,
} from "@match-cut/infra";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

export const fixtureBreakdown = (() => {
  const { spoken_lines_internal: _s, ...b } = JSON.parse(
    readFileSync(
      new URL("../packages/providers/fixtures/pass1/default.json", import.meta.url),
      "utf8",
    ),
  ) as Breakdown & { spoken_lines_internal: string[] };
  return b as Breakdown;
})();

export const RULE: PlaybookRule = {
  feature: "hook_type",
  value: "question",
  title: "Open on a spoken question",
  how_to: "Make the first line a question to the viewer, before any title card.",
  evidence: { outliers_with: 4, outliers_known: 5, typical_with: 1, typical_known: 5 },
  confidence: "high",
  examples: [{ video_id: "mgold01v000001", timestamp: "00:00" }],
  counterexample: "mgold01v000005",
};

let n = 0;
export function playbookRecord(over: Partial<PlaybookRecord> = {}): PlaybookRecord {
  const t = new Date("2026-11-20T10:00:00Z");
  return {
    id: `pb_test_${Date.now()}_${++n}`,
    userId: "user_1",
    orgId: "org_1",
    status: "succeeded",
    stage: null,
    progress: null,
    source: { kind: "handle", handle: "mockgolden01" },
    settings: { windowDays: 90, maxVideos: 50, outlierThreshold: 2 },
    forceRefresh: false,
    channel: {
      id: "UCmockgolden01xxxxxxxxxx",
      title: "Mock Golden 01",
      handle: "mockgolden01",
      subscriberCount: 12300,
      subscriberCountHidden: false,
    },
    window: {
      from: "2026-08-22T10:00:00.000Z",
      to: "2026-11-20T10:00:00.000Z",
      uploadsSeen: 4,
      shortsEligible: 2,
      tooNew: 1,
      notShort: 1,
      unusable: 0,
    },
    baseline: { medianViews: 1000, medianEngagementRate: 0.05 },
    notEnoughData: null,
    videos: [
      video("mgold01v000001", "outlier", 5000, 5),
      video("mgold01v000002", "typical", 1000, 1),
      video("mgold01v000003", "too_new", 300, null),
      video("mgold01v000004", "not_short", 9000, null),
    ],
    comparison: {
      table: [],
      rules: [],
      houseStyle: [],
      outlierTopics: [],
      features: [],
    },
    content: {
      rules: [RULE],
      house_style: "Nearly every compared video cuts every 1 to 2 seconds.",
      not_explained: ["Timing and trends also play a part."],
      recipe_prompt_template: "Edit my footage into {{GOAL}}.\n1. Hook.\n2. Cut.\n3. Export.",
    },
    spokenLines: ["a line someone said in a breakout video"],
    warnings: [{ code: "SMALL_SAMPLE", message: "x" }],
    error: null,
    meta: {
      models: { pass1: "mock", features: "mock", playbook: "mock" },
      versions: { pass1: "p1.v1", features: "f1", comparison: "c1", playbook: "pb1" },
      cached: false,
      timingsMs: { total: 1200 },
      tokens: { input: 100, output: 50 },
      costUsd: 0.01,
    },
    createdAt: t,
    updatedAt: t,
    ...over,
  };
}

function video(
  id: string,
  group: PlaybookRecord["videos"][number]["group"],
  views: number,
  outlierScore: number | null,
): PlaybookRecord["videos"][number] {
  return {
    id,
    title: `Video ${id}`,
    publishedAt: "2026-10-01T10:00:00.000Z",
    durationSeconds: group === "not_short" ? 600 : 40,
    views,
    likes: group === "typical" ? null : 100,
    comments: 10,
    outlierScore,
    engagementRate: 0.02,
    group,
    compared: group === "outlier" || group === "typical",
    briefId: group === "outlier" ? "brf_1" : null,
  };
}

export function skillRecord(over: Partial<SkillRecord> = {}): SkillRecord {
  const t = new Date("2026-11-21T10:00:00Z");
  return {
    id: `sk_test_${Date.now()}_${++n}`,
    userId: "user_1",
    orgId: "org_1",
    name: "Question hooks",
    source: { type: "playbook", id: "pb_1" },
    sourceTitle: "Mock Golden 01",
    snapshot: {
      type: "playbook",
      generatedAt: "2026-11-20T10:00:00.000Z",
      channel: { id: "UCmockgolden01xxxxxxxxxx", title: "Mock Golden 01", handle: "mockgolden01" },
      settings: { windowDays: 90, maxVideos: 50, outlierThreshold: 2 },
      window: { from: "2026-08-22T10:00:00.000Z", to: "2026-11-20T10:00:00.000Z" },
      rules: [RULE],
      houseStyle: "",
      notExplained: ["Timing and trends also play a part."],
      recipePromptTemplate: null,
      warnings: [{ code: "SMALL_SAMPLE", message: "x" }],
      spokenFingerprints: ["0123456789abcdef"],
    },
    versions: { playbook: "pb1" },
    lastUsedAt: null,
    createdAt: t,
    updatedAt: t,
    ...over,
  };
}

export function briefRecord(over: Partial<BriefRecord> = {}): BriefRecord {
  const t = new Date("2026-11-21T10:00:00Z");
  return {
    id: `brf_test_${++n}`,
    userId: "user_1",
    orgId: "org_1",
    status: "succeeded",
    stage: null,
    videoId: "dQw4w9WgXcQ",
    video: { title: "A reference", channel: "Someone", durationSeconds: 40, embeddable: true },
    range: null,
    detail: "standard",
    goal: "secret goal",
    targetFormat: "match",
    targetLengthSeconds: null,
    outputLanguage: "en",
    forceRefresh: false,
    breakdown: fixtureBreakdown,
    spokenLines: ["spoken"],
    prompt: null,
    warnings: [],
    error: null,
    meta: { model: "mock", pass2Model: "mock", cached: false, timingsMs: {}, tokens: {} },
    createdAt: t,
    updatedAt: t,
    ...over,
  };
}

/** The behavior every PlaybookStore and SkillStore must have, in memory and in Postgres. */
export function storeContract(
  label: string,
  make: () => { playbooks: PlaybookStore; skills: SkillStore },
) {
  describe(`${label}: playbook store`, () => {
    it("round-trips every field, and rejects a duplicate ID", async () => {
      const { playbooks } = make();
      const rec = playbookRecord();
      await playbooks.create(rec);
      expect(await playbooks.get(rec.id)).toEqual(rec);
      expect(await playbooks.get("pb_missing")).toBeNull();
      await expect(playbooks.create(rec)).rejects.toThrow();
      await playbooks.delete(rec.id);
    });

    it("stores text Postgres would reject (NUL, lone surrogates) as U+FFFD", async () => {
      const { playbooks } = make();
      const rec = playbookRecord();
      rec.videos[0]!.title = "bad\u0000title\uD800";
      await playbooks.create(rec);
      await playbooks.update(rec.id, { warnings: [{ code: "SMALL_SAMPLE", message: "a\u0000b" }] });
      const got = (await playbooks.get(rec.id))!;
      expect(got.videos[0]!.title).toBe("bad\uFFFDtitle\uFFFD");
      expect(got.warnings[0]!.message).toBe("a\uFFFDb");
      await playbooks.delete(rec.id);
    });

    it("leaves undefined fields alone; null clears", async () => {
      const { playbooks } = make();
      const rec = playbookRecord({ status: "processing", stage: "watching" });
      await playbooks.create(rec);
      const next = await playbooks.update(rec.id, { stage: undefined, content: null });
      expect(next).toMatchObject({ stage: "watching", content: null });
      expect((await playbooks.get(rec.id))!.stage).toBe("watching");
      await playbooks.delete(rec.id);
    });

    it("updates only while the status allows it (a cancel wins over a late finish)", async () => {
      const { playbooks } = make();
      const rec = playbookRecord({ status: "cancelled" });
      await playbooks.create(rec);
      const late = await playbooks.update(
        rec.id,
        { status: "succeeded" },
        { onlyIfStatus: ["queued", "processing"] },
      );
      expect(late).toBeNull();
      expect((await playbooks.get(rec.id))!.status).toBe("cancelled");
      const ok = await playbooks.update(rec.id, { stage: null }, { onlyIfStatus: ["cancelled"] });
      expect(ok).not.toBeNull();
      await playbooks.delete(rec.id);
    });

    it("finds the user's recent succeeded playbook for a channel and settings", async () => {
      const { playbooks } = make();
      const user = `user_recent_${++n}`;
      const channelId = `UCrecent${n}xxxxxxxxxxxxx`;
      const channel = { ...playbookRecord().channel!, id: channelId };
      const at = (h: number) => new Date(Date.UTC(2026, 10, 20, h));
      const recs = [
        playbookRecord({ userId: user, channel, createdAt: at(1) }),
        playbookRecord({ userId: user, channel, createdAt: at(5) }),
        playbookRecord({ userId: user, channel, createdAt: at(9), status: "failed" }),
        playbookRecord({
          userId: user,
          channel,
          createdAt: at(10),
          settings: { windowDays: 30, maxVideos: 50, outlierThreshold: 2 },
        }),
        playbookRecord({ userId: `${user}_other`, channel, createdAt: at(11) }),
      ];
      for (const r of recs) await playbooks.create(r);
      const q = { userId: user, channelId, settings: recs[0]!.settings };
      expect((await playbooks.findRecent({ ...q, since: at(0) }))!.id).toBe(recs[1]!.id);
      expect(await playbooks.findRecent({ ...q, since: at(6) })).toBeNull();
      expect(await playbooks.findRecent({ ...q, channelId: "UCnone", since: at(0) })).toBeNull();
      // The channel column follows channel updates.
      const moved = `UCmoved${n}xxxxxxxxxxxxxx`;
      await playbooks.update(recs[1]!.id, { channel: { ...channel, id: moved } });
      expect((await playbooks.findRecent({ ...q, channelId: moved, since: at(0) }))!.id).toBe(
        recs[1]!.id,
      );
      expect(await playbooks.countByUserSince(user, at(5))).toBe(3);
      expect(await playbooks.countByUserSince(user, at(0))).toBe(4);
      for (const r of recs) await playbooks.delete(r.id);
    });

    it("updates fields and the update time", async () => {
      const { playbooks } = make();
      const rec = playbookRecord({ status: "processing", stage: "watching", content: null });
      await playbooks.create(rec);
      const next = await playbooks.update(rec.id, {
        progress: { done: 2, total: 8 },
        warnings: [],
      });
      expect(next).toMatchObject({ stage: "watching", progress: { done: 2, total: 8 } });
      expect(next!.warnings).toEqual([]);
      expect(next!.updatedAt.getTime()).toBeGreaterThan(rec.updatedAt.getTime());
      expect(await playbooks.update("pb_missing", { stage: null })).toBeNull();
      await playbooks.delete(rec.id);
    });

    it("deletes one, and old ones for retention", async () => {
      const { playbooks } = make();
      // Far in the past, so a shared development database has nothing older.
      const old = playbookRecord({ createdAt: new Date("2001-01-01T00:00:00Z") });
      const fresh = playbookRecord({ createdAt: new Date() });
      const gone = playbookRecord();
      for (const r of [old, fresh, gone]) await playbooks.create(r);
      await playbooks.delete(gone.id);
      expect(await playbooks.get(gone.id)).toBeNull();
      expect(
        await playbooks.deleteOlderThan(new Date("2001-01-02T00:00:00Z")),
      ).toBeGreaterThanOrEqual(1);
      expect(await playbooks.get(old.id)).toBeNull();
      expect(await playbooks.get(fresh.id)).not.toBeNull();
      await playbooks.delete(fresh.id);
    });
  });

  describe(`${label}: skill store`, () => {
    it("round-trips every field", async () => {
      const { skills } = make();
      const user = `user_rt_${++n}`;
      const rec = skillRecord({ userId: user, lastUsedAt: new Date("2026-11-22T00:00:00Z") });
      expect(await skills.create(rec, 50)).toBe(true);
      expect(await skills.get(rec.id)).toEqual(rec);
      expect(await skills.get("sk_missing")).toBeNull();
      await expect(skills.create(rec, 50)).rejects.toThrow();
      await skills.delete(rec.id);
      expect(await skills.get(rec.id)).toBeNull();
    });

    it("enforces the per-user limit, even for concurrent saves", async () => {
      const { skills } = make();
      const user = `user_limit_${++n}`;
      const results = await Promise.all(
        Array.from({ length: 6 }, () => skills.create(skillRecord({ userId: user }), 3)),
      );
      expect(results.filter(Boolean)).toHaveLength(3);
      expect(await skills.listByUser(user)).toHaveLength(3);
      // Another user's skills don't count.
      expect(await skills.create(skillRecord({ userId: `${user}_other` }), 3)).toBe(true);
      for (const s of await skills.listByUser(user)) await skills.delete(s.id);
      for (const s of await skills.listByUser(`${user}_other`)) await skills.delete(s.id);
    });

    it("lists a user's skills, most recently used first", async () => {
      const { skills } = make();
      const user = `user_list_${++n}`;
      const at = (d: string) => new Date(`2026-11-${d}T00:00:00Z`);
      const a = skillRecord({ userId: user, name: "a", createdAt: at("01") });
      const b = skillRecord({ userId: user, name: "b", createdAt: at("02"), lastUsedAt: at("10") });
      const c = skillRecord({ userId: user, name: "c", createdAt: at("05") });
      for (const s of [a, b, c]) await skills.create(s, 50);
      expect((await skills.listByUser(user)).map((s) => s.name)).toEqual(["b", "c", "a"]);
      await skills.markUsed(a.id, at("20"));
      expect((await skills.listByUser(user)).map((s) => s.name)).toEqual(["a", "b", "c"]);
      expect(await skills.listByUser("nobody")).toEqual([]);
      for (const s of [a, b, c]) await skills.delete(s.id);
    });

    it("breaks ties by ID in byte order, whatever the database collation", async () => {
      const { skills } = make();
      const user = `user_tie_${++n}`;
      const ids = [`sk_tie${n}_a`, `sk_tie${n}__`, `sk_tie${n}_B`];
      for (const id of ids) await skills.create(skillRecord({ id, userId: user }), 50);
      // "B" (0x42) < "_" (0x5F) < "a" (0x61).
      expect((await skills.listByUser(user)).map((s) => s.id)).toEqual([ids[2], ids[1], ids[0]]);
      for (const id of ids) await skills.delete(id);
    });

    it("marks a skill used without counting it as an edit", async () => {
      const { skills } = make();
      const rec = skillRecord({ userId: `user_used_${++n}` });
      await skills.create(rec, 50);
      await skills.markUsed(rec.id, new Date("2026-11-25T00:00:00Z"));
      const got = (await skills.get(rec.id))!;
      expect(got.lastUsedAt).toEqual(new Date("2026-11-25T00:00:00Z"));
      expect(got.updatedAt).toEqual(rec.updatedAt);
      const renamed = await skills.update(rec.id, { name: "New", snapshot: undefined });
      expect(renamed).toMatchObject({ name: "New", snapshot: rec.snapshot });
      await skills.delete(rec.id);
    });

    it("updates the name, snapshot and versions", async () => {
      const { skills } = make();
      const rec = skillRecord({ userId: `user_up_${++n}` });
      await skills.create(rec, 50);
      const next = await skills.update(rec.id, {
        name: "Renamed",
        versions: { playbook: "pb2" },
        sourceTitle: "New title",
      });
      expect(next).toMatchObject({
        name: "Renamed",
        versions: { playbook: "pb2" },
        sourceTitle: "New title",
        snapshot: rec.snapshot,
      });
      expect(await skills.update("sk_missing", { name: "x" })).toBeNull();
      await skills.delete(rec.id);
    });
  });
}
