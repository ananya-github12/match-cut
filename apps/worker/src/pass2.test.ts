import { loadManifest, type Breakdown } from "@match-cut/core";
import {
  MockAnalyzer,
  mockPrompt,
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
});
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
