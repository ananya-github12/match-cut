/**
 * Pass 2 with post-processing: write, normalize, schema + semantic checks (word count, no URLs
 * or markdown, no injected instructions, originality vs the reference's spoken lines), one repair.
 *
 * The shot list never costs the user their prompt: if only the shot list is still wrong after
 * the repair (or the repair call fails), the prompt is kept and the shot list is dropped.
 */
import {
  checkPass2,
  MatchCutError,
  normalizePass2,
  targetSeconds,
  type Pass2CheckOptions,
  type Pass2Output,
} from "@match-cut/core";
import type {
  ApplyPlaybookInput,
  CallContext,
  UpstreamFailure,
  ModelResult,
  VideoAnalyzer,
  WritePromptInput,
} from "@match-cut/providers";
import { REPAIR_TIMEOUT_MS } from "./pass1.js";

export interface Pass2Run {
  /** Failed upstream attempts (retries, fallbacks) behind this result. */
  upstreamFailures: UpstreamFailure[];
  output: Pass2Output;
  model: string;
  fallbackUsed: boolean;
  tokens: { input: number; output: number };
  repairUsed: boolean;
  problems: string[];
  /** The shot list failed its checks and was left empty; the prompt is fine. */
  shotListDropped: boolean;
}

const asText = (r: ModelResult) => r.text ?? JSON.stringify(r.output);

export async function writeAndValidate(
  analyzer: VideoAnalyzer,
  input: WritePromptInput,
  spokenLines: string[],
  signal?: AbortSignal,
  /** Called after the model answers, before checks and any repair (the "validating" stage). */
  beforeValidate?: () => Promise<void>,
  ctx?: CallContext,
  /** A saved skill's speech fingerprints, for the copy check when the lines are gone. */
  spokenFingerprints?: readonly string[],
): Promise<Pass2Run> {
  return validatedPrompt(
    analyzer,
    () => analyzer.writePrompt(input, signal, ctx),
    2,
    {
      spokenLines,
      spokenFingerprints,
      language: input.language,
      beatCount: input.breakdown.beats.length,
      targetSeconds: targetSeconds(input.breakdown, input.lengthSeconds),
    },
    signal,
    beforeValidate,
    ctx,
  );
}

/**
 * Apply (PRD-playbooks.md): a prompt and shot list from a playbook's rules, with pass 2's checks
 * and the same one repair. Shots map to the prompt's steps, so there's no beat count to check.
 */
export async function applyAndValidate(
  analyzer: VideoAnalyzer,
  input: ApplyPlaybookInput,
  copyCheck: { spokenLines: string[]; spokenFingerprints?: readonly string[] },
  signal?: AbortSignal,
  ctx?: CallContext,
): Promise<Pass2Run> {
  return validatedPrompt(
    analyzer,
    () => analyzer.applyPlaybook(input, signal, ctx),
    "apply",
    {
      spokenLines: copyCheck.spokenLines,
      spokenFingerprints: copyCheck.spokenFingerprints,
      language: input.language,
      targetSeconds: input.lengthSeconds,
    },
    signal,
    undefined,
    ctx,
  );
}

/** Write, check, one repair; the prompt is kept when only the shot list is still wrong. */
async function validatedPrompt(
  analyzer: VideoAnalyzer,
  write: () => Promise<ModelResult>,
  repairPass: 2 | "apply",
  opts: Pass2CheckOptions,
  signal?: AbortSignal,
  beforeValidate?: () => Promise<void>,
  ctx?: CallContext,
): Promise<Pass2Run> {
  const first = await write();
  await beforeValidate?.();
  const tokens = { input: first.usage.inputTokens, output: first.usage.outputTokens };
  const check =
    first.output === undefined
      ? { ok: false, output: null, problems: ["The response was not valid JSON."] }
      : checkPass2(normalizePass2(first.output), opts);
  const firstRun = (dropped: boolean): Pass2Run => ({
    output: check.output!,
    model: first.model,
    fallbackUsed: first.fallbackUsed ?? false,
    tokens,
    repairUsed: false,
    upstreamFailures: first.upstreamFailures ?? [],
    problems: dropped ? check.problems : [],
    shotListDropped: dropped,
  });
  if (check.ok && check.output) return firstRun(false);
  let repaired;
  try {
    repaired = await analyzer.repair(
      {
        pass: repairPass,
        previousOutput: asText(first),
        problems: check.problems,
        model: first.model,
      },
      signal,
      { budget: ctx?.budget, timeoutMs: REPAIR_TIMEOUT_MS },
    );
  } catch (err) {
    // The prompt was already fine; only the shot list needed fixing. Keep the prompt.
    if (check.output && !signal?.aborted) return firstRun(true);
    throw err;
  }
  tokens.input += repaired.usage.inputTokens;
  tokens.output += repaired.usage.outputTokens;
  const second =
    repaired.output === undefined
      ? { ok: false, output: null, problems: ["The repaired response was not valid JSON."] }
      : checkPass2(normalizePass2(repaired.output), opts);
  if (!second.output) {
    // The repair broke a prompt that was fine before: keep the first one.
    if (check.output) return { ...firstRun(true), tokens };
    throw new MatchCutError(
      "INVALID_MODEL_OUTPUT",
      {},
      {
        pass: repairPass,
        problemsBefore: check.problems,
        problemsAfter: second.problems,
      },
    );
  }
  return {
    output: second.output,
    model: first.model,
    fallbackUsed: (first.fallbackUsed ?? false) || (repaired.fallbackUsed ?? false),
    tokens,
    repairUsed: true,
    upstreamFailures: [...(first.upstreamFailures ?? []), ...(repaired.upstreamFailures ?? [])],
    problems: check.problems,
    shotListDropped: !second.ok,
  };
}
