/**
 * Pass 1 with post-processing: watch, normalize, schema + semantic checks, one repair call.
 * PRD: "Backend: Gemini integration > Post-processing and validation". Shared by the pipeline and
 * the fixture recorder.
 */
import { checkPass1, MatchCutError, normalizePass1, type Pass1Output } from "@match-cut/core";
import type {
  CallContext,
  UpstreamFailure,
  ModelResult,
  VideoAnalyzer,
  WatchInput,
} from "@match-cut/providers";

/** PRD stage budget for validation and repair. */
export const REPAIR_TIMEOUT_MS = 20_000;

export interface Pass1Run {
  /** Failed upstream attempts (retries, fallbacks) behind this result. */
  upstreamFailures: UpstreamFailure[];
  output: Pass1Output;
  /** Model that produced the output (a fallback model if the requested one was overloaded). */
  model: string;
  fallbackUsed: boolean;
  attempts: number;
  tokens: { input: number; output: number };
  repairUsed: boolean;
  /** Problems found before the repair call, for logs and recordings. */
  problems: string[];
  /** Raw responses, for recordings. */
  raw: { watch: string | undefined; repair?: string | undefined };
}

function asText(res: ModelResult): string {
  return res.text ?? JSON.stringify(res.output);
}

export async function watchAndValidate(
  analyzer: VideoAnalyzer,
  input: WatchInput,
  /** Length of the analyzed section, or null if unknown. */
  analyzedSeconds: number | null,
  signal?: AbortSignal,
  ctx?: CallContext,
): Promise<Pass1Run> {
  const first = await analyzer.watch(input, signal, ctx);
  const tokens = { input: first.usage.inputTokens, output: first.usage.outputTokens };
  const check =
    first.output === undefined
      ? { ok: false, output: null, problems: ["The response was not valid JSON."] }
      : checkPass1(normalizePass1(first.output), analyzedSeconds);
  if (check.ok && check.output) {
    return {
      output: check.output,
      model: first.model,
      fallbackUsed: first.fallbackUsed ?? false,
      attempts: first.attempts ?? 1,
      tokens,
      repairUsed: false,
      upstreamFailures: first.upstreamFailures ?? [],
      problems: [],
      raw: { watch: first.text },
    };
  }

  const repaired = await analyzer.repair(
    // Repair on the model that wrote the output.
    { pass: 1, previousOutput: asText(first), problems: check.problems, model: first.model },
    signal,
    { budget: ctx?.budget, timeoutMs: REPAIR_TIMEOUT_MS },
  );
  tokens.input += repaired.usage.inputTokens;
  tokens.output += repaired.usage.outputTokens;
  const second =
    repaired.output === undefined
      ? { ok: false, output: null, problems: ["The repaired response was not valid JSON."] }
      : checkPass1(normalizePass1(repaired.output), analyzedSeconds);
  if (!second.ok || !second.output) {
    throw new MatchCutError(
      "INVALID_MODEL_OUTPUT",
      {},
      {
        problemsBefore: check.problems,
        problemsAfter: second.problems,
        repairUsed: true,
        // The calls still cost tokens: callers that track cost can count them.
        usage: {
          model: first.model,
          tokens,
          fallbackUsed: (first.fallbackUsed ?? false) || (repaired.fallbackUsed ?? false),
          upstreamFailures: [
            ...(first.upstreamFailures ?? []),
            ...(repaired.upstreamFailures ?? []),
          ],
        },
      },
    );
  }
  return {
    output: second.output,
    model: first.model,
    fallbackUsed: (first.fallbackUsed ?? false) || (repaired.fallbackUsed ?? false),
    attempts: (first.attempts ?? 1) + (repaired.attempts ?? 1),
    tokens,
    repairUsed: true,
    upstreamFailures: [...(first.upstreamFailures ?? []), ...(repaired.upstreamFailures ?? [])],
    problems: check.problems,
    raw: { watch: first.text, repair: repaired.text },
  };
}
