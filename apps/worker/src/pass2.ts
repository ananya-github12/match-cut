/**
 * Pass 2 with post-processing: write, normalize, schema + semantic checks (word count, no URLs
 * or markdown, no injected instructions, originality vs the reference's spoken lines), one repair.
 */
import { checkPass2, MatchCutError, normalizePass2, type Pass2Output } from "@match-cut/core";
import type {
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
): Promise<Pass2Run> {
  const opts = { spokenLines, language: input.language };
  const first = await analyzer.writePrompt(input, signal, ctx);
  await beforeValidate?.();
  const tokens = { input: first.usage.inputTokens, output: first.usage.outputTokens };
  const check =
    first.output === undefined
      ? { ok: false, output: null, problems: ["The response was not valid JSON."] }
      : checkPass2(normalizePass2(first.output), opts);
  if (check.ok && check.output) {
    return {
      output: check.output,
      model: first.model,
      fallbackUsed: first.fallbackUsed ?? false,
      tokens,
      repairUsed: false,
      upstreamFailures: first.upstreamFailures ?? [],
      problems: [],
    };
  }
  const repaired = await analyzer.repair(
    { pass: 2, previousOutput: asText(first), problems: check.problems, model: first.model },
    signal,
    { budget: ctx?.budget, timeoutMs: REPAIR_TIMEOUT_MS },
  );
  tokens.input += repaired.usage.inputTokens;
  tokens.output += repaired.usage.outputTokens;
  const second =
    repaired.output === undefined
      ? { ok: false, output: null, problems: ["The repaired response was not valid JSON."] }
      : checkPass2(normalizePass2(repaired.output), opts);
  if (!second.ok || !second.output) {
    throw new MatchCutError(
      "INVALID_MODEL_OUTPUT",
      {},
      {
        pass: 2,
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
  };
}
