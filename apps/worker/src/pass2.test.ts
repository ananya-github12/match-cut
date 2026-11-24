import { loadManifest, type Breakdown } from "@match-cut/core";
import {
  MockAnalyzer,
  mockPrompt,
  mockShotList,
  type ModelResult,
  type RepairInput,
  type VideoAnalyzer,
  type WritePromptInput,
} from "@match-cut/providers";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { writeAndValidate } from "./pass2.js";

const { spoken_lines_internal, ...breakdown } = JSON.parse(
  readFileSync(
    new URL("../../../packages/providers/fixtures/pass1/default.json", import.meta.url),
    "utf8",
  ),
) as Breakdown & { spoken_lines_internal: string[] };
const input: WritePromptInput = {
  breakdown,
  goal: "A launch video",
  format: "match",
  lengthSeconds: null,
  language: "en",
  manifest: loadManifest(),
  model: "m",
};
const good = () => ({
  cardboard_prompt: mockPrompt(input),
  assets_needed: ["Takes"],
  watch_outs: ["Write your own hook."],
  shot_list: mockShotList(input),
});
/** Valid prompt, shot list with too few shots. */
const badShots = () => ({ ...good(), shot_list: mockShotList(input).slice(0, 2) });
const res = (output: unknown): ModelResult => ({
  output,
  text: JSON.stringify(output),
  model: "m",
  usage: { inputTokens: 100, outputTokens: 50 },
});

function fake(write: ModelResult, repair: ModelResult = res(good())) {
  const mock = new MockAnalyzer();
  return {
    watch: mock.watch.bind(mock),
    writePrompt: vi.fn(async () => write),
    repair: vi.fn(async (_i: RepairInput) => repair),
    extractFeatures: mock.extractFeatures.bind(mock),
  } satisfies VideoAnalyzer;
}

describe("writeAndValidate", () => {
  it("the mock prompt passes every check with no repair", async () => {
    const a = fake(res(good()));
    const before = vi.fn(async () => {});
    const r = await writeAndValidate(a, input, spoken_lines_internal, undefined, before);
    expect(r.repairUsed).toBe(false);
    expect(before).toHaveBeenCalledOnce();
    expect(a.repair).not.toHaveBeenCalled();
  });

  it("too short: one pass 2 repair call with the problems", async () => {
    const a = fake(res({ ...good(), cardboard_prompt: "1. Cut.\n2. Caption.\n3. Music." }));
    const r = await writeAndValidate(a, input, spoken_lines_internal);
    expect(r.repairUsed).toBe(true);
    const sent = a.repair.mock.calls[0]![0];
    expect(sent.pass).toBe(2);
    expect(sent.problems.join()).toMatch(/at least 150/);
    expect(r.tokens).toEqual({ input: 200, output: 100 });
  });

  it("quoting the reference's speech triggers a repair", async () => {
    const quoted = `${good().cardboard_prompt} Say: ${spoken_lines_internal[0]} ${spoken_lines_internal[1]}`;
    const a = fake(res({ ...good(), cardboard_prompt: quoted }));
    // The two fixture lines together are under 13 words, so this alone passes:
    const r = await writeAndValidate(a, input, [spoken_lines_internal.join(" ")]);
    expect(r.repairUsed).toBe(true);
    expect(a.repair.mock.calls[0]![0].problems.join()).toMatch(/consecutive words/);
  });

  it("still failing after repair: INVALID_MODEL_OUTPUT", async () => {
    const bad = res({ ...good(), cardboard_prompt: "too short" });
    const a = fake(bad, bad);
    await expect(writeAndValidate(a, input, [])).rejects.toMatchObject({
      error: { code: "INVALID_MODEL_OUTPUT" },
    });
  });
});

describe("writeAndValidate shot list (never costs the prompt)", () => {
  it("a good shot list is kept, with no repair", async () => {
    const a = fake(res(good()));
    const r = await writeAndValidate(a, input, spoken_lines_internal);
    expect(r).toMatchObject({ repairUsed: false, shotListDropped: false });
    expect(r.output.shot_list.length).toBeGreaterThanOrEqual(4);
  });

  it("a bad shot list gets one repair; fixed, it's kept", async () => {
    const a = fake(res(badShots()), res(good()));
    const r = await writeAndValidate(a, input, spoken_lines_internal);
    expect(a.repair).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ repairUsed: true, shotListDropped: false });
    expect(r.output.shot_list.length).toBeGreaterThanOrEqual(4);
  });

  it("still bad after the repair: the prompt is kept and the shot list dropped", async () => {
    const a = fake(res(badShots()), res(badShots()));
    const r = await writeAndValidate(a, input, spoken_lines_internal);
    expect(r).toMatchObject({ repairUsed: true, shotListDropped: true });
    expect(r.output.cardboard_prompt).toBe(good().cardboard_prompt);
    expect(r.output.shot_list).toEqual([]);
  });

  it("the repair call fails: the first prompt is kept, shot list dropped", async () => {
    const a = fake(res(badShots()));
    a.repair.mockRejectedValueOnce(new Error("model busy"));
    const r = await writeAndValidate(a, input, spoken_lines_internal);
    expect(r).toMatchObject({ shotListDropped: true });
    expect(r.output.cardboard_prompt).toBe(good().cardboard_prompt);
  });

  it("the repair breaks a prompt that was fine: the first prompt is kept", async () => {
    const a = fake(res(badShots()), res({ ...good(), cardboard_prompt: "1. Too short." }));
    const r = await writeAndValidate(a, input, spoken_lines_internal);
    expect(r).toMatchObject({ shotListDropped: true });
    expect(r.output.cardboard_prompt).toBe(good().cardboard_prompt);
  });

  it("a bad prompt still fails after the repair, as before", async () => {
    const broken = { ...good(), cardboard_prompt: "1. Too short." };
    const a = fake(res(broken), res(broken));
    await expect(writeAndValidate(a, input, spoken_lines_internal)).rejects.toMatchObject({
      error: { code: "INVALID_MODEL_OUTPUT" },
    });
  });
});
