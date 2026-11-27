import {
  MockAnalyzer,
  type ModelResult,
  type VideoAnalyzer,
  type WatchInput,
} from "@match-cut/providers";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { watchAndValidate } from "./pass1.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../packages/providers/fixtures/pass1/default.json", import.meta.url),
    "utf8",
  ),
);
const input: WatchInput = {
  videoId: "mockShort01",
  canonicalUrl: "https://www.youtube.com/watch?v=mockShort01",
  range: null,
  detail: "standard",
  model: "m",
  durationSeconds: 45,
};
const result = (output: unknown, text?: string): ModelResult => ({
  output,
  text: text ?? JSON.stringify(output),
  model: "m",
  usage: { inputTokens: 100, outputTokens: 10 },
});
const overlapping = () => {
  const o = structuredClone(fixture);
  o.beats[1].start = "00:01";
  return o;
};

function fake(
  watch: ModelResult,
  repair?: ModelResult,
): VideoAnalyzer & { repair: ReturnType<typeof vi.fn> } {
  const base = new MockAnalyzer();
  return {
    watch: vi.fn(async () => watch),
    writePrompt: base.writePrompt.bind(base),
    repair: vi.fn(async () => repair ?? result(fixture)),
    extractFeatures: base.extractFeatures.bind(base),
    writePlaybook: base.writePlaybook.bind(base),
    applyPlaybook: base.applyPlaybook.bind(base),
  };
}

describe("watchAndValidate", () => {
  it("valid output: no repair call", async () => {
    const a = fake(result(fixture));
    const r = await watchAndValidate(a, input, 45);
    expect(r.repairUsed).toBe(false);
    expect(a.repair).not.toHaveBeenCalled();
    expect(r.tokens).toEqual({ input: 100, output: 10 });
  });

  it("semantic failure: one repair call with the problems, then success", async () => {
    const a = fake(result(overlapping()));
    const r = await watchAndValidate(a, input, 45);
    expect(r.repairUsed).toBe(true);
    expect(a.repair).toHaveBeenCalledTimes(1);
    const sent = a.repair.mock.calls[0]![0];
    expect(sent.problems.join()).toMatch(/overlapping/);
    expect(sent.previousOutput).toContain('"start":"00:01"');
    expect(r.tokens).toEqual({ input: 200, output: 20 });
  });

  it("invalid JSON: repaired once", async () => {
    const a = fake(result(undefined, "{oops"));
    const r = await watchAndValidate(a, input, 45);
    expect(r.repairUsed).toBe(true);
    expect(a.repair.mock.calls[0]![0]).toMatchObject({
      previousOutput: "{oops",
      problems: ["The response was not valid JSON."],
    });
  });

  it("still failing after repair: INVALID_MODEL_OUTPUT", async () => {
    const a = fake(result(overlapping()), result(overlapping()));
    await expect(watchAndValidate(a, input, 45)).rejects.toMatchObject({
      error: { code: "INVALID_MODEL_OUTPUT", retryable: true },
    });
    expect(a.repair).toHaveBeenCalledTimes(1);
  });

  it("timestamps past the analyzed section are caught", async () => {
    const a = fake(result(fixture), result(fixture));
    await expect(watchAndValidate(a, input, 20)).rejects.toMatchObject({
      error: { code: "INVALID_MODEL_OUTPUT" },
    });
  });
});

describe("watchAndValidate with a fallback model", () => {
  it("reports the fallback and repairs on the model that answered", async () => {
    const a = fake({ ...result(overlapping()), model: "lite", fallbackUsed: true, attempts: 3 });
    const r = await watchAndValidate(a, input, 45);
    expect(r).toMatchObject({ model: "lite", fallbackUsed: true, repairUsed: true });
    expect(a.repair.mock.calls[0]![0].model).toBe("lite");
  });
});
