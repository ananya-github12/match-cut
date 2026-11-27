/**
 * Fixture-based provider for offline development and every test (PROVIDER=mock).
 * Pass 1 returns fixtures/pass1/<videoId>.json, or default.json. Pass 2 fills a template from
 * the breakdown and the user's goal, format and length, so regenerating visibly changes the prompt.
 */
import {
  UNKNOWN,
  countWords,
  defaultExampleMoment,
  fallbackCopy,
  formatTimecode,
  GOAL_SLOT,
  houseStyleLine,
  MatchCutError,
  targetSeconds,
  type Breakdown,
  type FeatureName,
  type PlaybookFacts,
  type PlaybookOutput,
  type Shot,
} from "@match-cut/core";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError, type GenerateContentResponse } from "@google/genai";
import { mockFeatures } from "../youtube/mock-channels.js";
import { mapGeminiError, readResponse } from "./gemini.js";
import type {
  ExtractFeaturesInput,
  CallContext,
  ModelResult,
  RepairInput,
  VideoAnalyzer,
  WatchInput,
  WritePlaybookInput,
  WritePromptInput,
} from "./types.js";

/**
 * Scripted failures for tests (PRD M5: "each failure row has a test using MockProvider fault
 * injection"). Each call to a method consumes the next fault in its list; an empty list means
 * normal mock behaviour. Faults go through the real Gemini error mapping.
 */
export type MockFault =
  | { status: number; message?: string } // HTTP error from Gemini (429, 503, 403, ...)
  | { finishReason: string } // e.g. SAFETY, RECITATION, MAX_TOKENS
  | { blockReason: string } // promptFeedback.blockReason
  | "empty" // no candidates
  | "timeout" // the request timed out
  | "hang" // never answers until aborted (for job-budget tests)
  | { output: unknown; text?: string }; // a specific (possibly invalid) response body

export interface MockCall {
  method: "watch" | "writePrompt" | "repair" | "extractFeatures" | "writePlaybook";
  model: string;
  hint?: string;
  timeoutMs?: number;
}

function fakeResponse(
  over: Partial<{ finishReason: string; blockReason: string; empty: boolean }>,
) {
  return {
    candidates: over.empty
      ? []
      : [{ content: { parts: [{ text: "{}" }] }, finishReason: over.finishReason ?? "STOP" }],
    ...(over.blockReason ? { promptFeedback: { blockReason: over.blockReason } } : {}),
  } as unknown as GenerateContentResponse;
}

async function applyFault(
  fault: MockFault,
  model: string,
  signal?: AbortSignal,
): Promise<ModelResult> {
  if (fault === "hang") {
    return new Promise((_, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
  }
  if (fault === "timeout") {
    throw mapGeminiError(
      Object.assign(new Error("Request timed out"), { name: "TimeoutError" }),
      signal,
    );
  }
  if (fault === "empty") readResponse(fakeResponse({ empty: true }));
  if (typeof fault === "object" && "status" in fault) {
    throw mapGeminiError(
      new ApiError({ status: fault.status, message: fault.message ?? `mock ${fault.status}` }),
      signal,
    );
  }
  if (typeof fault === "object" && "finishReason" in fault)
    readResponse(fakeResponse({ finishReason: fault.finishReason }));
  if (typeof fault === "object" && "blockReason" in fault)
    readResponse(fakeResponse({ blockReason: fault.blockReason }));
  if (typeof fault === "object" && "output" in fault) {
    return {
      output: fault.output,
      text: fault.text,
      model,
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }
  throw new Error(`unhandled mock fault ${JSON.stringify(fault)}`);
}

const FIXTURES = fileURLToPath(new URL("../../fixtures/pass1/", import.meta.url));

/** Video IDs that trigger failures, for tests and demos. */
export const MOCK_FAULT_IDS = {
  pass1Fails: "mockFailP1a",
  pass2Fails: "mockFailP2a",
  slow: "mockSlow001",
} as const;

export interface MockAnalyzerOptions {
  faults?: Partial<Record<MockCall["method"], MockFault[]>>;
  /** Simulated latency per pass. Tests use 0. */
  watchDelayMs?: number;
  writeDelayMs?: number;
  /** Extra latency for MOCK_FAULT_IDS.slow, so cancel can be demoed. */
  slowDelayMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}

function loadFixture(videoId: string): unknown {
  const specific = `${FIXTURES}${videoId}.json`;
  const file = existsSync(specific) ? specific : `${FIXTURES}default.json`;
  return JSON.parse(readFileSync(file, "utf8"));
}

const toSeconds = (mmss: string) => {
  const m = /^(\d+):(\d{2})$/.exec(mmss);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const toMmSs = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.round(s) % 60).padStart(2, "0")}`;

/**
 * Stretches a fixture's timestamps to the analyzed length, so mock analysis of a real video
 * (VIDEO_LOOKUP=youtube) fits that video and passes the pass 1 checks.
 */
export function fitFixtureToLength(fixture: unknown, seconds: number | null): unknown {
  const f = fixture as { format: { duration: string }; beats: { start: string; end: string }[] };
  const from = toSeconds(f.format.duration);
  if (!seconds || !from || seconds === from) return fixture;
  const scale = (v: string) =>
    toMmSs(Math.min(seconds, Math.floor((toSeconds(v) ?? 0) * (seconds / from))));
  return {
    ...f,
    format: { ...f.format, duration: toMmSs(seconds) },
    beats: f.beats.map((b) => ({ ...b, start: scale(b.start), end: scale(b.end) })),
  };
}

const FORMAT_WORDS: Record<string, string> = {
  "9:16": "vertical 9:16",
  "16:9": "horizontal 16:9",
  "1:1": "square 1:1",
  "4:5": "4:5 portrait",
};

const MOCK_FRAMINGS = [
  "tight close-up, eye level, phone vertical",
  "medium shot, waist up, slightly off-center",
  "over-the-shoulder screen recording, cropped to fill the frame",
  "wide establishing shot, steady, natural light",
];

/** A shot list that passes the checks: one shot per beat (at least 4), durations summing to the target. */
export function mockShotList(input: WritePromptInput): Shot[] {
  const beats = input.breakdown.beats;
  const count = Math.min(15, Math.max(4, beats.length));
  const total = targetSeconds(input.breakdown, input.lengthSeconds) ?? 30;
  const each = Math.round((total / count) * 10) / 10;
  return Array.from({ length: count }, (_, i) => {
    const beat = beats[i % beats.length]!;
    return {
      shot: `My own take on the "${beat.label}" moment, about my topic`,
      framing: MOCK_FRAMINGS[i % MOCK_FRAMINGS.length]!,
      duration_seconds: i === count - 1 ? Math.round((total - each * (count - 1)) * 10) / 10 : each,
      maps_to_beat: (i % beats.length) + 1,
      notes: i === 0 ? "Start talking in the first second; no intro." : "",
    };
  });
}

export function mockPrompt(input: WritePromptInput): string {
  const b: Breakdown = input.breakdown;
  const goal = input.goal.trim() || "a video on my own topic in this style";
  const sameFormat = input.format === "match" || input.format === b.format.aspect_ratio;
  const format = sameFormat
    ? `Keep the ${b.format.aspect_ratio} frame.`
    : `Reframe my footage to ${FORMAT_WORDS[input.format]}: center-crop on the speaker and stack any screen recording above the face.`;
  const length = input.lengthSeconds
    ? `Target ${formatTimecode(input.lengthSeconds)} total. Keep the hook and the ending, and condense the middle beats to fit.`
    : `Match the reference length of about ${b.format.duration}.`;
  const shot = b.format.avg_shot_length_seconds;
  return [
    `Edit my footage into ${goal}, using the structure and pacing of the reference.`,
    `1. Rough cut: open on my strongest line within the first second, with no intro. Order the rest as ${b.beats.map((x) => x.label.toLowerCase()).join(", then ")}.`,
    `2. Pacing: remove silences and pauses longer than 0.3 seconds. Aim for shots of about ${shot} seconds, cutting on the beat near the end.`,
    `3. Framing: ${format} Add 110 to 120 percent punch-in zooms on every second or third cut to keep energy up.`,
    `4. Captions: add word-by-word captions, 2 to 4 words per line, bold sans-serif with the active word highlighted, in the lower third.`,
    `5. Graphics: add a short numbered title card for each main point in my footage.`,
    `6. Music and sound: generate low-volume upbeat music under my voice, and add a whoosh on transitions and a pop when titles appear. If my footage lacks b-roll for a point, generate it.`,
    `7. Color: apply a warm, bright grade.`,
    `8. Ending: ${length} Finish on a clear call to action and cut hard to black on the last beat.`,
  ].join("\n");
}

/** Generic recipe steps; a step is skipped when a rule already covers its feature. */
const MOCK_RECIPE_STEPS: { feature?: FeatureName; text: string }[] = [
  {
    text: "Rough cut: keep only my strongest takes, remove silences and pauses longer than 0.3 seconds, and order the points so each one builds on the last.",
  },
  {
    feature: "caption_style",
    text: "Captions: add clear captions in a bold sans-serif font in the lower third, sized for a phone screen and kept in sync with my voice.",
  },
  {
    feature: "music",
    text: "Sound: keep my voice clear and even, add a soft whoosh on transitions, and keep any music well below the voice.",
  },
  {
    text: "Color: apply a bright, natural grade so skin tones look warm and consistent from shot to shot.",
  },
  {
    text: "B-roll: if my footage lacks a shot for a point, generate a short b-roll clip that shows it instead of holding on one angle.",
  },
  {
    feature: "ending",
    text: "Ending: finish on the strongest payoff line and cut hard on the final beat, with no long outro or end card.",
  },
  {
    text: "Review: watch the whole cut once at normal speed and trim any moment where the energy drops or a point repeats.",
  },
  {
    text: "Export: vertical 9:16 at full resolution, with audio levels even from start to finish.",
  },
];
const MOCK_RECIPE_WORDS = 180;

/** A playbook that passes every check: fallback wording, code-valid examples, a 150+ word recipe. */
export function mockPlaybook(facts: PlaybookFacts): PlaybookOutput {
  const rules = facts.rules.map((r) => {
    const carrier = facts.outliers.find((o) => o.features[r.feature] === r.value);
    // Like a model: the opening or ending for moment features, the second beat otherwise.
    const beats = carrier?.breakdown.beats ?? [];
    const mid = beats[Math.min(1, beats.length - 1)]?.start ?? null;
    const moment = carrier ? (defaultExampleMoment(r.feature, carrier) ?? mid) : null;
    return {
      feature: r.feature,
      value: r.value,
      ...fallbackCopy(r.feature, r.value),
      examples: carrier && moment ? [{ video_id: carrier.videoId, timestamp: moment }] : [],
    };
  });
  const lines = [`Edit my footage into ${GOAL_SLOT}, following this playbook's rules.`];
  let step = 1;
  for (const r of rules) lines.push(`${step++}. ${r.title}: ${r.how_to}`);
  for (const s of MOCK_RECIPE_STEPS) {
    if (countWords(lines.join(" ")) >= MOCK_RECIPE_WORDS) break;
    if (s.feature && rules.some((r) => r.feature === s.feature)) continue;
    lines.push(`${step++}. ${s.text}`);
  }
  return {
    rules,
    house_style: facts.houseStyle.length
      ? houseStyleLine(facts.houseStyle) ||
        "Nearly every compared video shares the same basic look, so it isn't what sets the breakouts apart."
      : "",
    not_explained: [
      ...(facts.outlierTopics.length
        ? [
            `The breakouts share topics (${facts.outlierTopics.slice(0, 3).join(", ")}), so the topic may matter as much as the edit.`,
          ]
        : []),
      "Posting time, trends and the audience also play a part, beyond the edit.",
    ],
    recipe_prompt_template: lines.join("\n"),
  };
}

export class MockAnalyzer implements VideoAnalyzer {
  /** Every call, in order, for assertions. */
  readonly calls: MockCall[] = [];
  /** The last video watched, so a pass 1 repair returns that video's fixture. */
  private lastVideoId = "default";

  constructor(private readonly opts: MockAnalyzerOptions = {}) {}

  private async fault(
    method: MockCall["method"],
    model: string,
    signal?: AbortSignal,
    ctx?: CallContext,
  ): Promise<ModelResult | null> {
    this.calls.push({ method, model, hint: ctx?.hint, timeoutMs: ctx?.timeoutMs });
    const next = this.opts.faults?.[method]?.shift();
    return next === undefined ? null : applyFault(next, model, signal);
  }

  async watch(input: WatchInput, signal?: AbortSignal, ctx?: CallContext): Promise<ModelResult> {
    const faulted = await this.fault("watch", input.model, signal, ctx);
    if (faulted) return faulted;
    this.lastVideoId = input.videoId;
    await sleep(this.opts.watchDelayMs ?? 0, signal);
    if (input.videoId === MOCK_FAULT_IDS.slow) await sleep(this.opts.slowDelayMs ?? 0, signal);
    if (input.videoId === MOCK_FAULT_IDS.pass1Fails) throw new MatchCutError("UPSTREAM_ERROR");
    return {
      output: fitFixtureToLength(
        loadFixture(input.videoId),
        input.range ? input.range.end_seconds - input.range.start_seconds : input.durationSeconds,
      ),
      model: input.model,
      usage: { inputTokens: 18000, outputTokens: 1200 },
    };
  }

  async extractFeatures(
    input: ExtractFeaturesInput,
    signal?: AbortSignal,
    ctx?: CallContext,
  ): Promise<ModelResult> {
    const faulted = await this.fault("extractFeatures", input.model, signal, ctx);
    if (faulted) return faulted;
    // Every answer quotes real breakdown text, so it survives the grounding check.
    const quote = input.breakdown.hook.split(/\s+/).slice(0, 8).join(" ");
    const output = Object.fromEntries(
      Object.entries(mockFeatures(input.videoId)).map(([feature, value]) => [
        feature,
        { value, evidence: value === UNKNOWN ? "" : quote },
      ]),
    );
    return {
      output,
      text: JSON.stringify(output),
      model: input.model,
      usage: { inputTokens: 1200, outputTokens: 80 },
    };
  }

  async writePlaybook(
    input: WritePlaybookInput,
    signal?: AbortSignal,
    ctx?: CallContext,
  ): Promise<ModelResult> {
    const faulted = await this.fault("writePlaybook", input.model, signal, ctx);
    if (faulted) return faulted;
    const output = mockPlaybook(input.facts);
    return {
      output,
      text: JSON.stringify(output),
      model: input.model,
      usage: { inputTokens: 6000, outputTokens: 900 },
    };
  }

  async writePrompt(
    input: WritePromptInput,
    signal?: AbortSignal,
    ctx?: CallContext,
  ): Promise<ModelResult> {
    const faulted = await this.fault("writePrompt", input.model, signal, ctx);
    if (faulted) return faulted;
    await sleep(this.opts.writeDelayMs ?? 0, signal);
    if (input.goal.includes(MOCK_FAULT_IDS.pass2Fails)) throw new MatchCutError("UPSTREAM_ERROR");
    return {
      output: {
        cardboard_prompt: mockPrompt(input),
        assets_needed: [
          "Talking-head takes of each main point, filmed vertically if possible",
          "Any screen recordings or product shots you want to show",
        ],
        watch_outs: [
          "Don't reuse the reference's script or on-screen wording; write your own hook.",
          "Pick your own music; the reference's track is not reused.",
        ],
        shot_list: mockShotList(input),
      },
      model: input.model,
      usage: { inputTokens: 3000, outputTokens: 800 },
    };
  }

  /**
   * Mock repair. Pass 1: the fixture of the video last watched; a fixture that breaks the checks
   * stays broken, so tests see INVALID_MODEL_OUTPUT honestly. Pass 2: the input unchanged.
   */
  async repair(input: RepairInput, signal?: AbortSignal, ctx?: CallContext): Promise<ModelResult> {
    const faulted = await this.fault("repair", input.model, signal, ctx);
    if (faulted) return faulted;
    if (input.pass === 2 || input.pass === "features" || input.pass === "playbook") {
      let output: unknown;
      try {
        output = JSON.parse(input.previousOutput);
      } catch {
        output = undefined;
      }
      return { output, model: input.model, usage: { inputTokens: 1500, outputTokens: 600 } };
    }
    return {
      output: loadFixture(this.lastVideoId),
      model: input.model,
      usage: { inputTokens: 2000, outputTokens: 1200 },
    };
  }
}
