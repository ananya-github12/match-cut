/**
 * Gemini provider. PRD: "Backend: Gemini integration > Request construction, pass 1".
 * Checked against @google/genai 2.32.0 types and the Gemini API docs (Nov 2026):
 * fileData.fileUri for YouTube, videoMetadata {startOffset "Ns", endOffset "Ns", fps},
 * config.mediaResolution, config.responseJsonSchema, thinkingConfig.thinkingLevel.
 *
 * One call per method; retries and the fallback chain live in fallback.ts (withFallback).
 */
import {
  canonicalYouTubeUrl,
  FEATURES_RESPONSE_SCHEMA,
  FEATURES_SYSTEM_INSTRUCTION,
  featuresRepairText,
  featuresUserText,
  MatchCutError,
  PASS1_RESPONSE_SCHEMA,
  PASS1_SYSTEM_INSTRUCTION,
  PASS2_RESPONSE_SCHEMA,
  PASS2_SYSTEM_INSTRUCTION,
  pass1RepairText,
  pass1UserText,
  pass2RepairText,
  pass2UserText,
  PLAYBOOK_RESPONSE_SCHEMA,
  PLAYBOOK_SYSTEM_INSTRUCTION,
  playbookRepairText,
  playbookUserText,
} from "@match-cut/core";
import {
  ApiError,
  GoogleGenAI,
  MediaResolution,
  ThinkingLevel,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";
import type {
  CallContext,
  ExtractFeaturesInput,
  ModelResult,
  RepairInput,
  RetryHint,
  VideoAnalyzer,
  WatchInput,
  WritePlaybookInput,
  WritePromptInput,
} from "./types.js";

/** The one SDK method we use; injectable for tests. */
export interface GenerateContentClient {
  generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
}

export interface GeminiAnalyzerOptions {
  apiKey?: string;
  client?: GenerateContentClient;
  /** PRD: "a moderate thinking budget". LOW keeps thinking inside the 4,096-token output cap. */
  thinkingLevel?: ThinkingLevel;
  /** PRD stage budgets: pass 1 up to 180 s, pass 2 up to 20 s. */
  pass1TimeoutMs?: number;
  pass2TimeoutMs?: number;
  repairTimeoutMs?: number;
  /** Playbook writing and its repair: more output than pass 2 (up to 5 rules plus a recipe). */
  playbookTimeoutMs?: number;
}

export const PASS1_GENERATION = {
  temperature: 0.3,
  maxOutputTokens: 4096,
} as const;

/**
 * Feature extraction: a short classification with a quote per answer; low temperature for
 * stable labels. Room for 8 quotes plus thinking, which counts toward the cap.
 */
export const FEATURES_GENERATION = {
  temperature: 0.1,
  maxOutputTokens: 2048,
} as const;

/**
 * Playbook writing: text only, up to 5 rules plus a recipe; a little latitude for wording.
 * Thinking counts toward the cap.
 */
export const PLAYBOOK_GENERATION = {
  temperature: 0.4,
  maxOutputTokens: 4096,
} as const;

/** Pass 2: text only. A little more latitude for wording; thinking counts toward the cap. */
export const PASS2_GENERATION = {
  temperature: 0.5,
  maxOutputTokens: 4096,
} as const;

const BLOCKED_FINISH = new Set([
  "SAFETY",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
]);

/** Section length in seconds, or null when unknown. */
export function sectionSeconds(input: WatchInput): number | null {
  if (input.range) return input.range.end_seconds - input.range.start_seconds;
  return input.durationSeconds;
}

/**
 * Frame rate. PRD: 1 fps by default; 2 fps for `deep`, or for videos under 60 s with very short
 * shots. Shot length is only known after pass 1, so every section under 60 s gets 2 fps.
 */
export function framesPerSecond(input: WatchInput): number | undefined {
  const s = sectionSeconds(input);
  if (input.detail === "deep") return 2;
  if (s !== null && s < 60) return 2;
  return undefined; // API default, 1 fps
}

/** PRD: default resolution up to 10 minutes, low above that. */
export function mediaResolution(input: WatchInput): MediaResolution | undefined {
  const s = sectionSeconds(input);
  return s !== null && s > 600 ? MediaResolution.MEDIA_RESOLUTION_LOW : undefined;
}

/**
 * How long one pass 1 attempt may wait, scaled to the analyzed length: 30 s plus 1.5 s per
 * second of video, at least 45 s, never above the PRD's 180 s stage budget. A 20 s Short gets
 * 60 s; anything over about 100 s gets the full 180 s. Unknown length: the full budget.
 */
export function pass1AttemptTimeoutMs(input: WatchInput, capMs = 180_000): number {
  const s = sectionSeconds(input);
  if (s === null) return capMs;
  return Math.min(capMs, Math.max(45_000, 30_000 + 1_500 * s));
}

/** PRD finish-reason retries: extra instruction text, and a higher output cap for MAX_TOKENS. */
export const HINT_TEXT: Record<RetryHint, string> = {
  no_quoting:
    "Important: the previous attempt was stopped for quoting. Describe everything in your own words. Do not quote or transcribe speech, lyrics or on-screen text. Return spoken_lines_internal as an empty array.",
  be_concise:
    "Important: the previous attempt ran out of space. Be concise: keep every text field short and specific.",
};
const BE_CONCISE_MAX_TOKENS = 8192;

function hinted(parts: { text: string }[] | undefined, hint?: RetryHint) {
  return hint ? [...(parts ?? []), { text: HINT_TEXT[hint] }] : (parts ?? []);
}

export function buildPass1Request(
  input: WatchInput,
  opts: { thinkingLevel: ThinkingLevel; timeoutMs: number; hint?: RetryHint },
  signal?: AbortSignal,
): GenerateContentParameters {
  // Never trust a passed-in URL: rebuild it from the ID.
  const fileUri = canonicalYouTubeUrl(input.videoId);
  if (input.canonicalUrl !== fileUri) throw new Error("canonicalUrl does not match videoId");
  const fps = framesPerSecond(input);
  const videoMetadata = {
    ...(input.range
      ? { startOffset: `${input.range.start_seconds}s`, endOffset: `${input.range.end_seconds}s` }
      : {}),
    ...(fps ? { fps } : {}),
  };
  const resolution = mediaResolution(input);
  return {
    model: input.model,
    contents: [
      {
        role: "user",
        parts: [
          {
            fileData: { fileUri },
            ...(Object.keys(videoMetadata).length ? { videoMetadata } : {}),
          },
          ...hinted(
            [{ text: pass1UserText(input.range ? sectionSeconds(input) : null) }],
            opts.hint,
          ),
        ],
      },
    ],
    config: {
      systemInstruction: PASS1_SYSTEM_INSTRUCTION,
      ...PASS1_GENERATION,
      ...(opts.hint === "be_concise" ? { maxOutputTokens: BE_CONCISE_MAX_TOKENS } : {}),
      responseMimeType: "application/json",
      responseJsonSchema: PASS1_RESPONSE_SCHEMA,
      thinkingConfig: { thinkingLevel: opts.thinkingLevel },
      ...(resolution ? { mediaResolution: resolution } : {}),
      abortSignal: signal,
      httpOptions: { timeout: opts.timeoutMs },
    },
  };
}

export function buildPass2Request(
  input: WritePromptInput,
  opts: { thinkingLevel: ThinkingLevel; timeoutMs: number; hint?: RetryHint },
  signal?: AbortSignal,
): GenerateContentParameters {
  return {
    model: input.model,
    contents: [{ role: "user", parts: hinted([{ text: pass2UserText(input) }], opts.hint) }],
    config: {
      systemInstruction: PASS2_SYSTEM_INSTRUCTION,
      ...PASS2_GENERATION,
      ...(opts.hint === "be_concise" ? { maxOutputTokens: BE_CONCISE_MAX_TOKENS } : {}),
      responseMimeType: "application/json",
      responseJsonSchema: PASS2_RESPONSE_SCHEMA,
      thinkingConfig: { thinkingLevel: opts.thinkingLevel },
      abortSignal: signal,
      httpOptions: { timeout: opts.timeoutMs },
    },
  };
}

/** Turns a response into text + parsed JSON, or throws the matching error code. */
export function readResponse(res: GenerateContentResponse): { text: string; output: unknown } {
  const blockReason = res.promptFeedback?.blockReason;
  if (blockReason) throw new MatchCutError("CONTENT_BLOCKED", {}, { blockReason });
  const candidate = res.candidates?.[0];
  if (!candidate) throw new MatchCutError("UPSTREAM_ERROR", {}, { reason: "no_candidates" });
  const finish = candidate.finishReason as string | undefined;
  if (finish && BLOCKED_FINISH.has(finish)) {
    throw new MatchCutError("CONTENT_BLOCKED", {}, { finishReason: finish });
  }
  if (finish === "RECITATION" || finish === "MAX_TOKENS") {
    throw new MatchCutError("INVALID_MODEL_OUTPUT", {}, { finishReason: finish });
  }
  const text = (candidate.content?.parts ?? [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("")
    .trim();
  if (!text)
    throw new MatchCutError("UPSTREAM_ERROR", {}, { reason: "empty_text", finishReason: finish });
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let output: unknown;
  try {
    output = JSON.parse(unfenced);
  } catch {
    output = undefined; // the pipeline repairs invalid JSON once
  }
  return { text, output };
}

function usageOf(res: GenerateContentResponse) {
  const u = res.usageMetadata;
  return {
    inputTokens: u?.promptTokenCount ?? 0,
    // Thinking tokens are billed as output.
    outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
  };
}

/** Maps SDK and network errors. Never lets raw upstream text reach users. */
export function mapGeminiError(err: unknown, signal?: AbortSignal): unknown {
  if (err instanceof MatchCutError) return err;
  if (signal?.aborted) return signal.reason ?? err; // cancelled: let the pipeline see it
  const name = (err as Error)?.name;
  const message = String((err as Error)?.message ?? err);
  if (name === "AbortError" || name === "TimeoutError" || /timed? ?out/i.test(message)) {
    return new MatchCutError("UPSTREAM_TIMEOUT", {}, { message });
  }
  if (err instanceof ApiError) {
    const detail = { status: err.status, message };
    // Billing problems affect every model on the key: no retry, no fallback; ops must act.
    if (
      (err.status === 403 || err.status === 429) &&
      /billing|outstanding balance|payment/i.test(message)
    ) {
      return new MatchCutError("CAPACITY_EXHAUSTED", {}, { ...detail, billing: true });
    }
    if (err.status === 429) return new MatchCutError("CAPACITY_EXHAUSTED", {}, detail);
    if (err.status >= 500) return new MatchCutError("UPSTREAM_ERROR", {}, detail);
    // 400/403/404 about the video: the PRD re-runs the precheck to classify (M5).
    return new MatchCutError("UPSTREAM_ERROR", {}, { ...detail, clientError: true });
  }
  return new MatchCutError("UPSTREAM_ERROR", {}, { message });
}

export class GeminiAnalyzer implements VideoAnalyzer {
  private readonly client: GenerateContentClient;
  private readonly thinkingLevel: ThinkingLevel;
  private readonly pass1TimeoutMs: number;
  private readonly pass2TimeoutMs: number;
  private readonly repairTimeoutMs: number;
  private readonly playbookTimeoutMs: number;

  constructor(opts: GeminiAnalyzerOptions) {
    if (!opts.client && !opts.apiKey) throw new Error("GeminiAnalyzer needs an apiKey or a client");
    this.client =
      opts.client ??
      new GoogleGenAI({
        apiKey: opts.apiKey,
        // withFallback owns retries and the fallback chain; the SDK must not retry on its own.
        httpOptions: { retryOptions: { attempts: 1 } },
      }).models;
    this.thinkingLevel = opts.thinkingLevel ?? ThinkingLevel.LOW;
    this.pass1TimeoutMs = opts.pass1TimeoutMs ?? 180_000;
    this.pass2TimeoutMs = opts.pass2TimeoutMs ?? 20_000;
    this.repairTimeoutMs = opts.repairTimeoutMs ?? 20_000;
    this.playbookTimeoutMs = opts.playbookTimeoutMs ?? 45_000;
  }

  async watch(
    input: WatchInput,
    signal?: AbortSignal,
    ctx: CallContext = {},
  ): Promise<ModelResult> {
    const params = buildPass1Request(
      input,
      {
        thinkingLevel: this.thinkingLevel,
        timeoutMs: Math.min(
          pass1AttemptTimeoutMs(input, this.pass1TimeoutMs),
          ctx.timeoutMs ?? Infinity,
        ),
        hint: ctx.hint,
      },
      signal,
    );
    let res: GenerateContentResponse;
    try {
      res = await this.client.generateContent(params);
    } catch (err) {
      throw mapGeminiError(err, signal);
    }
    const { text, output } = readResponse(res);
    return {
      output,
      text,
      model: input.model,
      modelVersion: res.modelVersion,
      usage: usageOf(res),
    };
  }

  async repair(
    input: RepairInput,
    signal?: AbortSignal,
    ctx: CallContext = {},
  ): Promise<ModelResult> {
    const spec = {
      1: {
        text: pass1RepairText,
        system: PASS1_SYSTEM_INSTRUCTION,
        generation: PASS1_GENERATION,
        schema: PASS1_RESPONSE_SCHEMA,
      },
      2: {
        text: pass2RepairText,
        system: PASS2_SYSTEM_INSTRUCTION,
        generation: PASS2_GENERATION,
        schema: PASS2_RESPONSE_SCHEMA,
      },
      features: {
        text: featuresRepairText,
        system: FEATURES_SYSTEM_INSTRUCTION,
        generation: FEATURES_GENERATION,
        schema: FEATURES_RESPONSE_SCHEMA,
      },
      playbook: {
        text: playbookRepairText,
        system: PLAYBOOK_SYSTEM_INSTRUCTION,
        generation: PLAYBOOK_GENERATION,
        schema: PLAYBOOK_RESPONSE_SCHEMA,
      },
    }[input.pass];
    return this.call(
      {
        model: input.model,
        contents: [
          { role: "user", parts: [{ text: spec.text(input.previousOutput, input.problems) }] },
        ],
        config: {
          systemInstruction: spec.system,
          ...spec.generation,
          responseMimeType: "application/json",
          responseJsonSchema: spec.schema,
          thinkingConfig: { thinkingLevel: this.thinkingLevel },
          abortSignal: signal,
          httpOptions: {
            timeout: Math.min(
              input.pass === "playbook" ? this.playbookTimeoutMs : this.repairTimeoutMs,
              ctx.timeoutMs ?? Infinity,
            ),
          },
        },
      },
      input.model,
      signal,
    );
  }

  async extractFeatures(
    input: ExtractFeaturesInput,
    signal?: AbortSignal,
    ctx: CallContext = {},
  ): Promise<ModelResult> {
    return this.call(
      {
        model: input.model,
        contents: [{ role: "user", parts: [{ text: featuresUserText(input.breakdown) }] }],
        config: {
          systemInstruction: FEATURES_SYSTEM_INSTRUCTION,
          ...FEATURES_GENERATION,
          responseMimeType: "application/json",
          responseJsonSchema: FEATURES_RESPONSE_SCHEMA,
          thinkingConfig: { thinkingLevel: this.thinkingLevel },
          abortSignal: signal,
          httpOptions: { timeout: Math.min(this.pass2TimeoutMs, ctx.timeoutMs ?? Infinity) },
        },
      },
      input.model,
      signal,
    );
  }

  async writePlaybook(
    input: WritePlaybookInput,
    signal?: AbortSignal,
    ctx: CallContext = {},
  ): Promise<ModelResult> {
    // As pass 2: a retry after MAX_TOKENS asks for concision and raises the cap.
    const text = playbookUserText(input.facts, input.manifest, input.language);
    return this.call(
      {
        model: input.model,
        contents: [{ role: "user", parts: hinted([{ text }], ctx.hint) }],
        config: {
          systemInstruction: PLAYBOOK_SYSTEM_INSTRUCTION,
          ...PLAYBOOK_GENERATION,
          ...(ctx.hint === "be_concise" ? { maxOutputTokens: BE_CONCISE_MAX_TOKENS } : {}),
          responseMimeType: "application/json",
          responseJsonSchema: PLAYBOOK_RESPONSE_SCHEMA,
          thinkingConfig: { thinkingLevel: this.thinkingLevel },
          abortSignal: signal,
          httpOptions: { timeout: Math.min(this.playbookTimeoutMs, ctx.timeoutMs ?? Infinity) },
        },
      },
      input.model,
      signal,
    );
  }

  async writePrompt(
    input: WritePromptInput,
    signal?: AbortSignal,
    ctx: CallContext = {},
  ): Promise<ModelResult> {
    const params = buildPass2Request(
      input,
      {
        thinkingLevel: this.thinkingLevel,
        timeoutMs: Math.min(this.pass2TimeoutMs, ctx.timeoutMs ?? Infinity),
        hint: ctx.hint,
      },
      signal,
    );
    return this.call(params, input.model, signal);
  }

  private async call(
    params: GenerateContentParameters,
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelResult> {
    let res: GenerateContentResponse;
    try {
      res = await this.client.generateContent(params);
    } catch (err) {
      throw mapGeminiError(err, signal);
    }
    const { text, output } = readResponse(res);
    return { output, text, model, modelVersion: res.modelVersion, usage: usageOf(res) };
  }
}
