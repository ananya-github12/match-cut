import {
  ApiError,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";
import {
  MatchCutError,
  FEATURES_RESPONSE_SCHEMA,
  FEATURES_SYSTEM_INSTRUCTION,
  PASS1_RESPONSE_SCHEMA,
  PASS1_SYSTEM_INSTRUCTION,
  PASS2_RESPONSE_SCHEMA,
  PASS2_SYSTEM_INSTRUCTION,
  PLAYBOOK_RESPONSE_SCHEMA,
  PLAYBOOK_SYSTEM_INSTRUCTION,
  FEATURE_NAMES,
  loadManifest,
  type Breakdown,
  type FeatureRow,
  type PlaybookFacts,
} from "@match-cut/core";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildPass1Request,
  GeminiAnalyzer,
  pass1AttemptTimeoutMs,
  readResponse,
} from "./gemini.js";
import type { WatchInput } from "./types.js";

const ID = "dQw4w9WgXcQ";
const { spoken_lines_internal: _s, ...fixtureBreakdown } = JSON.parse(
  readFileSync(new URL("../../fixtures/pass1/default.json", import.meta.url), "utf8"),
) as Breakdown & { spoken_lines_internal: string[] };
const input = (over: Partial<WatchInput> = {}): WatchInput => ({
  videoId: ID,
  canonicalUrl: `https://www.youtube.com/watch?v=${ID}`,
  range: null,
  detail: "standard",
  model: "gemini-test-flash",
  durationSeconds: 120,
  ...over,
});
const opts = { thinkingLevel: "LOW" as never, timeoutMs: 180000 };
const resp = (
  over: Partial<GenerateContentResponse> & { text?: string; finishReason?: string } = {},
) =>
  ({
    candidates: [
      {
        content: { parts: [{ text: over.text ?? '{"a":1}' }] },
        finishReason: over.finishReason ?? "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
    modelVersion: "gemini-test-flash-001",
    ...over,
  }) as unknown as GenerateContentResponse;

function part(p: GenerateContentParameters) {
  const contents = p.contents as { parts: Record<string, unknown>[] }[];
  return contents[0]!.parts;
}

describe("buildPass1Request (PRD request construction)", () => {
  it("sends the canonical URL as fileData with the schema and generation config", () => {
    const p = buildPass1Request(input(), opts);
    expect(p.model).toBe("gemini-test-flash");
    expect(part(p)[0]).toEqual({ fileData: { fileUri: `https://www.youtube.com/watch?v=${ID}` } });
    expect(part(p)[1]!.text).toMatch(/whole video/);
    expect(p.config).toMatchObject({
      systemInstruction: PASS1_SYSTEM_INSTRUCTION,
      temperature: 0.3,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
      responseJsonSchema: PASS1_RESPONSE_SCHEMA,
      thinkingConfig: { thinkingLevel: "LOW" },
      httpOptions: { timeout: 180000 },
    });
    expect(p.config).not.toHaveProperty("mediaResolution");
  });

  it("refuses a URL that doesn't match the ID", () => {
    expect(() =>
      buildPass1Request(input({ canonicalUrl: "https://evil.example/x" }), opts),
    ).toThrow();
  });

  it("adds start and end offsets for a clip range", () => {
    const p = buildPass1Request(
      input({ range: { start_seconds: 40, end_seconds: 160 }, durationSeconds: 900 }),
      opts,
    );
    expect(part(p)[0]!.videoMetadata).toEqual({ startOffset: "40s", endOffset: "160s" });
    expect(part(p)[1]!.text).toMatch(/120-second section/);
  });

  it("uses 2 fps for deep and for sections under 60 s, default otherwise", () => {
    expect(part(buildPass1Request(input({ detail: "deep" }), opts))[0]!.videoMetadata).toEqual({
      fps: 2,
    });
    expect(part(buildPass1Request(input({ durationSeconds: 45 }), opts))[0]!.videoMetadata).toEqual(
      { fps: 2 },
    );
    expect(part(buildPass1Request(input({ durationSeconds: 60 }), opts))[0]).not.toHaveProperty(
      "videoMetadata",
    );
    const clip = buildPass1Request(
      input({ range: { start_seconds: 0, end_seconds: 30 }, durationSeconds: 600 }),
      opts,
    );
    expect(part(clip)[0]!.videoMetadata).toEqual({ startOffset: "0s", endOffset: "30s", fps: 2 });
  });

  it("uses low media resolution above 10 minutes", () => {
    expect(buildPass1Request(input({ durationSeconds: 600 }), opts).config).not.toHaveProperty(
      "mediaResolution",
    );
    expect(buildPass1Request(input({ durationSeconds: 601 }), opts).config).toMatchObject({
      mediaResolution: "MEDIA_RESOLUTION_LOW",
    });
  });

  it("passes the abort signal through", () => {
    const signal = new AbortController().signal;
    expect(buildPass1Request(input(), opts, signal).config?.abortSignal).toBe(signal);
  });
});

describe("readResponse", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as MatchCutError).error.code;
    }
    return "none";
  };
  it("parses JSON text, ignoring thought parts and code fences", () => {
    const r = resp({
      candidates: [
        {
          content: {
            parts: [{ text: "thinking...", thought: true }, { text: '```json\n{"x":2}\n```' }],
          },
          finishReason: "STOP",
        },
      ] as never,
    });
    expect(readResponse(r).output).toEqual({ x: 2 });
  });
  it("returns undefined output for invalid JSON so the pipeline can repair it", () => {
    expect(readResponse(resp({ text: "{not json" }))).toEqual({
      text: "{not json",
      output: undefined,
    });
  });
  it("maps blocks, finish reasons and empty responses", () => {
    expect(
      code(() => readResponse(resp({ promptFeedback: { blockReason: "SAFETY" } } as never))),
    ).toBe("CONTENT_BLOCKED");
    for (const f of ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]) {
      expect(code(() => readResponse(resp({ finishReason: f })))).toBe("CONTENT_BLOCKED");
    }
    expect(code(() => readResponse(resp({ finishReason: "RECITATION" })))).toBe(
      "INVALID_MODEL_OUTPUT",
    );
    expect(code(() => readResponse(resp({ finishReason: "MAX_TOKENS" })))).toBe(
      "INVALID_MODEL_OUTPUT",
    );
    expect(code(() => readResponse(resp({ candidates: [] } as never)))).toBe("UPSTREAM_ERROR");
    expect(code(() => readResponse(resp({ text: "  " })))).toBe("UPSTREAM_ERROR");
  });
  it("refused responses still carry the tokens they were billed for", () => {
    for (const r of [
      resp({ finishReason: "SAFETY" }),
      resp({ finishReason: "RECITATION" }),
      resp({ text: "  " }),
    ]) {
      try {
        readResponse(r);
        expect.unreachable();
      } catch (e) {
        // Thinking tokens are billed as output.
        expect((e as MatchCutError).detail?.attemptTokens).toEqual({
          inputTokens: 10,
          outputTokens: 8,
        });
      }
    }
  });
});

describe("GeminiAnalyzer", () => {
  it("watch returns output, raw text, model version and usage (thinking billed as output)", async () => {
    const generateContent = vi.fn(async () => resp());
    const a = new GeminiAnalyzer({ client: { generateContent } });
    const r = await a.watch(input());
    expect(r).toEqual({
      output: { a: 1 },
      text: '{"a":1}',
      model: "gemini-test-flash",
      modelVersion: "gemini-test-flash-001",
      usage: { inputTokens: 10, outputTokens: 8 },
    });
  });

  it("repair sends the failed output and problems as text only", async () => {
    const generateContent = vi.fn(async (_p: GenerateContentParameters) => resp());
    const a = new GeminiAnalyzer({ client: { generateContent } });
    await a.repair({
      pass: 1,
      previousOutput: '{"bad":true}',
      problems: ["beats[1]: overlapping"],
      model: "m",
    });
    const sent = generateContent.mock.calls[0]![0];
    const parts = part(sent);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toContain('{"bad":true}');
    expect(parts[0]!.text).toContain("- beats[1]: overlapping");
    expect(sent.config?.responseJsonSchema).toBe(PASS1_RESPONSE_SCHEMA);
  });

  it("maps SDK errors to PRD codes without leaking upstream text", async () => {
    const fail = (err: unknown) =>
      new GeminiAnalyzer({ client: { generateContent: async () => Promise.reject(err) } })
        .watch(input())
        .catch((e: MatchCutError) => e);
    const e429 = await fail(new ApiError({ status: 429, message: "quota secret details" }));
    expect(e429).toBeInstanceOf(MatchCutError);
    expect((e429 as MatchCutError).error).toEqual({
      code: "CAPACITY_EXHAUSTED",
      message: "Match Cut is at capacity. Try again in a few minutes.",
      retryable: true,
    });
    expect(
      ((await fail(new ApiError({ status: 503, message: "x" }))) as MatchCutError).error.code,
    ).toBe("UPSTREAM_ERROR");
    expect(
      ((await fail(new ApiError({ status: 403, message: "x" }))) as MatchCutError).error.code,
    ).toBe("UPSTREAM_ERROR");
    const timeout = Object.assign(new Error("Request timed out"), { name: "TimeoutError" });
    expect(((await fail(timeout)) as MatchCutError).error.code).toBe("UPSTREAM_TIMEOUT");
  });

  it("a cancelled call rethrows the abort reason, not an error code", async () => {
    const c = new AbortController();
    const reason = new Error("cancelled");
    c.abort(reason);
    const a = new GeminiAnalyzer({
      client: { generateContent: async () => Promise.reject(new Error("aborted")) },
    });
    await expect(a.watch(input(), c.signal)).rejects.toBe(reason);
  });

  it("pass 2: text-only request with the pass 2 instruction, schema and 20 s budget", async () => {
    const generateContent = vi.fn(async (_p: GenerateContentParameters) => resp());
    const a = new GeminiAnalyzer({ client: { generateContent } });
    const manifest = { manifest_version: "t1", operations: [{ id: "cut", description: "Cut" }] };
    const r = await a.writePrompt({
      breakdown: fixtureBreakdown,
      goal: "My cooking channel https://evil.example/x",
      format: "16:9",
      lengthSeconds: 30,
      language: "en",
      manifest,
      model: "gemini-test-flash",
    });
    expect(r.model).toBe("gemini-test-flash");
    const sent = generateContent.mock.calls[0]![0];
    const parts = part(sent);
    expect(parts).toHaveLength(1);
    expect(parts[0]).not.toHaveProperty("fileData");
    const text = parts[0]!.text as string;
    expect(text).toContain("<<<USER_GOAL\nMy cooking channel\nUSER_GOAL>>>");
    expect(text).not.toContain("evil.example");
    expect(text).toContain("include reframing steps");
    expect(text).toContain("- cut: Cut");
    expect(sent.config).toMatchObject({
      systemInstruction: PASS2_SYSTEM_INSTRUCTION,
      responseJsonSchema: PASS2_RESPONSE_SCHEMA,
      responseMimeType: "application/json",
      httpOptions: { timeout: 20000 },
    });
  });

  it("pass 2 repair uses the pass 2 instruction and schema", async () => {
    const generateContent = vi.fn(async (_p: GenerateContentParameters) => resp());
    const a = new GeminiAnalyzer({ client: { generateContent } });
    await a.repair({ pass: 2, previousOutput: "{}", problems: ["too short"], model: "m" });
    const sent = generateContent.mock.calls[0]![0];
    expect(sent.config?.systemInstruction).toBe(PASS2_SYSTEM_INSTRUCTION);
    expect(sent.config?.responseJsonSchema).toBe(PASS2_RESPONSE_SCHEMA);
    expect(part(sent)[0]!.text).toContain("- too short");
  });
});

describe("pass1AttemptTimeoutMs", () => {
  it("scales with the analyzed length, between 45 s and the 180 s stage budget", () => {
    expect(pass1AttemptTimeoutMs(input({ durationSeconds: 5 }))).toBe(45_000);
    expect(pass1AttemptTimeoutMs(input({ durationSeconds: 19 }))).toBe(58_500);
    expect(pass1AttemptTimeoutMs(input({ durationSeconds: 600 }))).toBe(180_000);
    expect(pass1AttemptTimeoutMs(input({ durationSeconds: null }))).toBe(180_000);
  });
  it("uses the clip length when a range is set", () => {
    const clip = input({ durationSeconds: 1200, range: { start_seconds: 0, end_seconds: 20 } });
    expect(pass1AttemptTimeoutMs(clip)).toBe(60_000);
  });
});

describe("GeminiAnalyzer.extractFeatures (PRD-playbooks.md, Feature extraction)", () => {
  const breakdown = JSON.parse(
    readFileSync(new URL("../../fixtures/pass1/default.json", import.meta.url), "utf8"),
  );

  it("is text only: the breakdown as delimited data, the feature schema, no video", async () => {
    const generateContent = vi.fn(async (_p: GenerateContentParameters) =>
      resp({ text: '{"hook_type":"question"}' }),
    );
    const a = new GeminiAnalyzer({ client: { generateContent } });
    const r = await a.extractFeatures({ videoId: "abcdefghijk", breakdown, model: "m" });
    const sent = generateContent.mock.calls[0]![0];
    const parts = part(sent);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toContain("<<<BREAKDOWN");
    expect(parts[0]!.text).not.toContain("abcdefghijk");
    expect(JSON.stringify(sent.contents)).not.toContain("fileData");
    expect(sent.config?.responseJsonSchema).toBe(FEATURES_RESPONSE_SCHEMA);
    expect(sent.config?.systemInstruction).toBe(FEATURES_SYSTEM_INSTRUCTION);
    expect(sent.config?.temperature).toBe(0.1);
    expect(r.output).toEqual({ hook_type: "question" });
  });

  it("repairs feature output with the feature schema", async () => {
    const generateContent = vi.fn(async (_p: GenerateContentParameters) => resp());
    const a = new GeminiAnalyzer({ client: { generateContent } });
    await a.repair({
      pass: "features",
      previousOutput: '{"hook_type":"clickbait"}',
      problems: ["hook_type: invalid"],
      model: "m",
    });
    const sent = generateContent.mock.calls[0]![0];
    expect(part(sent)[0]!.text).toContain("hook_type: invalid");
    expect(sent.config?.responseJsonSchema).toBe(FEATURES_RESPONSE_SCHEMA);
  });
});

describe("GeminiAnalyzer.writePlaybook (PRD-playbooks.md, Playbook writing)", () => {
  const features = {
    ...Object.fromEntries(FEATURE_NAMES.map((f) => [f, "unknown"])),
    hook_type: "question",
  } as FeatureRow;
  const facts: PlaybookFacts = {
    rules: [
      {
        feature: "hook_type",
        value: "question",
        outliersWith: 4,
        outliersKnown: 5,
        typicalWith: 0,
        typicalKnown: 5,
        confidence: "high",
        difference: 0.8,
      },
    ],
    houseStyle: [],
    outlierTopics: [],
    outliers: [
      {
        videoId: ID,
        analyzedSeconds: 30,
        features,
        breakdown: fixtureBreakdown,
        spokenLines: ["a secret spoken line that must stay internal"],
      },
    ],
    avoidNames: ["Some Channel"],
  };

  it("is text only: delimited facts, the playbook schema, no video, no spoken lines", async () => {
    const generateContent = vi.fn(async (_p: GenerateContentParameters) =>
      resp({ text: '{"rules":[]}' }),
    );
    const a = new GeminiAnalyzer({ client: { generateContent } });
    const r = await a.writePlaybook({
      facts,
      manifest: loadManifest(),
      language: "en",
      model: "m",
    });
    const sent = generateContent.mock.calls[0]![0];
    const text = part(sent)[0]!.text!;
    expect(text).toContain("<<<FACTS");
    expect(text).not.toContain("a secret spoken line");
    expect(text).not.toContain("Some Channel");
    expect(JSON.stringify(sent.contents)).not.toContain("fileData");
    expect(sent.config?.responseJsonSchema).toBe(PLAYBOOK_RESPONSE_SCHEMA);
    expect(sent.config?.systemInstruction).toBe(PLAYBOOK_SYSTEM_INSTRUCTION);
    expect(sent.config?.temperature).toBe(0.4);
    expect(sent.config?.httpOptions?.timeout).toBe(45_000);
    expect(r.output).toEqual({ rules: [] });
  });

  it("a be_concise retry adds the hint and raises the token cap, as pass 2 does", async () => {
    const generateContent = vi.fn(async (_p: GenerateContentParameters) => resp());
    const a = new GeminiAnalyzer({ client: { generateContent } });
    await a.writePlaybook(
      { facts, manifest: loadManifest(), language: "en", model: "m" },
      undefined,
      { hint: "be_concise" },
    );
    const sent = generateContent.mock.calls[0]![0];
    expect(part(sent)).toHaveLength(2);
    expect(sent.config?.maxOutputTokens).toBe(8192);
  });

  it("repairs with the playbook schema and the playbook timeout", async () => {
    const generateContent = vi.fn(async (_p: GenerateContentParameters) => resp());
    const a = new GeminiAnalyzer({ client: { generateContent } });
    await a.repair(
      { pass: "playbook", previousOutput: "{}", problems: ["rules: Required"], model: "m" },
      undefined,
      { timeoutMs: 30_000 },
    );
    const sent = generateContent.mock.calls[0]![0];
    expect(part(sent)[0]!.text).toContain("rules: Required");
    expect(sent.config?.responseJsonSchema).toBe(PLAYBOOK_RESPONSE_SCHEMA);
    expect(sent.config?.httpOptions?.timeout).toBe(30_000);
  });
});
