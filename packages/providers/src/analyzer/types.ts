import type {
  AnalyzedRange,
  ApplyInputs,
  Breakdown,
  CapabilityManifest,
  Detail,
  PlaybookFacts,
  TargetFormat,
} from "@match-cut/core";

import type { JobBudget } from "./budget.js";

/** PRD finish-reason retries: RECITATION -> stricter no-quoting reminder; MAX_TOKENS -> be concise. */
export type RetryHint = "no_quoting" | "be_concise";

/** Per-call settings that ride alongside the input. */
export interface CallContext {
  /** Upper bound for this call; providers use the smaller of this and their stage budget. */
  timeoutMs?: number;
  hint?: RetryHint;
  budget?: JobBudget;
  /** Job time this call must leave unused, for later stages (pass 1 leaves room for pass 2). */
  reserveAfterMs?: number;
}

export interface UpstreamFailure {
  model: string;
  code: string;
  status?: number;
  finishReason?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface WatchInput {
  videoId: string;
  /** Always canonicalYouTubeUrl(videoId); never the user's raw URL. */
  canonicalUrl: string;
  range: AnalyzedRange | null;
  detail: Detail;
  model: string;
  /** Full video length from the precheck; null if the precheck was skipped. */
  durationSeconds: number | null;
}

/** Text-only: classify a breakdown's edit into playbook features (PRD-playbooks.md). */
export interface ExtractFeaturesInput {
  /** Not sent to the model; lets the offline mock vary by video. */
  videoId: string;
  breakdown: Breakdown;
  model: string;
}

/** Text-only: word a playbook from computed facts (PRD-playbooks.md, Playbook writing). */
export interface WritePlaybookInput {
  facts: PlaybookFacts;
  manifest: CapabilityManifest;
  language: string;
  model: string;
}

/** Text-only: a prompt and shot list from a playbook's rules (PRD-playbooks.md, apply). */
export interface ApplyPlaybookInput extends ApplyInputs {
  model: string;
}

export interface RepairInput {
  /** Which call's output is being repaired: pass 1, pass 2, playbook features, writing or apply. */
  pass: 1 | 2 | "features" | "playbook" | "apply";
  /** The model's previous output, as text. */
  previousOutput: string;
  /** Plain-English list of failed checks. */
  problems: string[];
  model: string;
}

export interface WritePromptInput {
  breakdown: Breakdown;
  goal: string;
  format: TargetFormat;
  lengthSeconds: number | null;
  language: string;
  manifest: CapabilityManifest;
  model: string;
}

/** Raw model output; the pipeline validates and, once, repairs it. */
export interface ModelResult {
  /** Parsed JSON, or undefined when the response wasn't valid JSON. */
  output: unknown;
  /** The response text as returned, for repair calls and recordings. */
  text?: string;
  /** Exact model version the API reports, e.g. "gemini-3.8-flash-001". */
  modelVersion?: string;
  /** Upstream attempts this result took, and whether a fallback model produced it. */
  attempts?: number;
  fallbackUsed?: boolean;
  /** Failed attempts before this result (retries, fallbacks). */
  upstreamFailures?: UpstreamFailure[];
  model: string;
  usage: Usage;
}

/** The provider adapter around the video model (PRD: "a thin provider adapter around Gemini"). */
export interface VideoAnalyzer {
  watch(input: WatchInput, signal?: AbortSignal, ctx?: CallContext): Promise<ModelResult>;
  writePrompt(
    input: WritePromptInput,
    signal?: AbortSignal,
    ctx?: CallContext,
  ): Promise<ModelResult>;
  /** One text-only repair call: fix the listed problems without re-watching. */
  repair(input: RepairInput, signal?: AbortSignal, ctx?: CallContext): Promise<ModelResult>;
  /** Text-only: a breakdown's edit as playbook features. */
  extractFeatures(
    input: ExtractFeaturesInput,
    signal?: AbortSignal,
    ctx?: CallContext,
  ): Promise<ModelResult>;
  /** Text-only: a playbook's wording from computed facts. */
  writePlaybook(
    input: WritePlaybookInput,
    signal?: AbortSignal,
    ctx?: CallContext,
  ): Promise<ModelResult>;
  /** Text-only: a prompt and shot list from a playbook's rules for the user's goal. */
  applyPlaybook(
    input: ApplyPlaybookInput,
    signal?: AbortSignal,
    ctx?: CallContext,
  ): Promise<ModelResult>;
}
