/**
 * M9: shot lists through the whole pipeline, in memory. PRD-playbooks.md, Feature 2.
 */
import type { CallContext, ModelResult, WritePromptInput } from "@match-cut/providers";
import { MOCK_VIDEOS, MockAnalyzer } from "@match-cut/providers";
import { describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

const SHORT = `https://youtube.com/shorts/${MOCK_VIDEOS.short.id}`;

/** Mock whose shot list is too short (2 shots) whenever the goal mentions "noshots". */
class FlakyShots extends MockAnalyzer {
  writes = 0;
  override async writePrompt(
    input: WritePromptInput,
    signal?: AbortSignal,
    ctx?: CallContext,
  ): Promise<ModelResult> {
    this.writes++;
    const res = await super.writePrompt(input, signal, ctx);
    if (!input.goal.includes("noshots")) return res;
    const output = res.output as { shot_list: unknown[] };
    const broken = { ...output, shot_list: output.shot_list.slice(0, 2) };
    return { ...res, output: broken, text: JSON.stringify(broken) };
  }
}

describe("shot list in briefs", () => {
  it("a finished brief has a shot list that adds up to about the reference length", async () => {
    const h = harness();
    const res = await h.post({ source: { url: SHORT }, goal: "A launch video for my app" });
    await h.idle();
    const brief = await h.brief(res.json().id);
    expect(brief.status).toBe("succeeded");
    expect(brief.shot_list!.length).toBeGreaterThanOrEqual(4);
    const total = brief.shot_list!.reduce((s, x) => s + x.duration_seconds, 0);
    expect(Math.abs(total - 45)).toBeLessThanOrEqual(45 * 0.25);
    const beats = brief.breakdown!.beats.length;
    for (const shot of brief.shot_list!) {
      expect(shot.maps_to_beat).toBeGreaterThanOrEqual(1);
      expect(shot.maps_to_beat).toBeLessThanOrEqual(beats);
    }
  });

  it("a target length changes the shot durations", async () => {
    const h = harness();
    const res = await h.post({ source: { url: SHORT }, target: { length_seconds: 20 } });
    await h.idle();
    const brief = await h.brief(res.json().id);
    const total = brief.shot_list!.reduce((s, x) => s + x.duration_seconds, 0);
    expect(Math.abs(total - 20)).toBeLessThanOrEqual(5);
  });

  it("an unfixable shot list keeps the prompt, warns, isn't cached, and regenerate brings it back", async () => {
    const analyzer = new FlakyShots();
    const h = harness({ analyzer });
    const res = await h.post({ source: { url: SHORT }, goal: "Launch video noshots" });
    await h.idle();
    const id = res.json().id;
    const brief = await h.brief(id);
    expect(brief.status).toBe("succeeded");
    expect(brief.cardboard_prompt).toMatch(/^1\. /m);
    expect(brief.shot_list).toEqual([]);
    expect(brief.warnings.map((w) => w.code)).toContain("SHOT_LIST_UNAVAILABLE");

    // Same inputs again: not served from cache, so the model really runs again.
    const writesBefore = analyzer.writes;
    await h.regenerate(id, { goal: "Launch video noshots" });
    await h.idle();
    expect(analyzer.writes).toBe(writesBefore + 1);

    // A working regenerate restores the list and clears the warning.
    await h.regenerate(id, { goal: "Launch video" });
    await h.idle();
    const fixed = await h.brief(id);
    expect(fixed.shot_list!.length).toBeGreaterThanOrEqual(4);
    expect(fixed.warnings.map((w) => w.code)).not.toContain("SHOT_LIST_UNAVAILABLE");
  });
});
