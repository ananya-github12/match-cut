/**
 * Per-video and text steps of the playbook pipeline (PRD-playbooks.md, Feature 3): feature
 * extraction with its one repair and grounding, and playbook writing with its one repair. Each
 * returns usage so the pipeline can count tokens and cost.
 */
import {
  checkFeatures,
  checkPlaybook,
  groundFeatures,
  MatchCutError,
  MODEL_FEATURE_NAMES,
  MODEL_FEATURES,
  UNKNOWN,
  type Breakdown,
  type CapabilityManifest,
  type FeatureValues,
  type ModelFeature,
  type PlaybookCheck,
  type PlaybookFacts,
} from "@match-cut/core";
import type {
  CallContext,
  ModelResult,
  UpstreamFailure,
  VideoAnalyzer,
} from "@match-cut/providers";
import { REPAIR_TIMEOUT_MS } from "./pass1.js";

export interface StepUsage {
  model: string;
  tokens: { input: number; output: number };
  fallbackUsed: boolean;
  upstreamFailures: UpstreamFailure[];
}

const asText = (r: ModelResult) => r.text ?? JSON.stringify(r.output);
const usageOf = (r: ModelResult): StepUsage => ({
  model: r.model,
  tokens: { input: r.usage.inputTokens, output: r.usage.outputTokens },
  fallbackUsed: r.fallbackUsed ?? false,
  upstreamFailures: r.upstreamFailures ?? [],
});

export interface FeaturesRun {
  values: FeatureValues;
  ungrounded: ModelFeature[];
  repairUsed: boolean;
  /** One entry per model call (the first, and the repair if any). */
  usage: StepUsage[];
}

/**
 * Classifies one breakdown: extract, schema check, one repair, then grounding (an answer whose
 * quote isn't in the breakdown becomes "unknown"). Throws INVALID_MODEL_OUTPUT if the output is
 * still unusable after the repair, so the pipeline can leave the video out rather than count it
 * as all-unknown.
 */
export async function extractAndGround(
  analyzer: VideoAnalyzer,
  input: { videoId: string; breakdown: Breakdown; model: string },
  signal?: AbortSignal,
  ctx?: CallContext,
): Promise<FeaturesRun> {
  const first = await analyzer.extractFeatures(input, signal, ctx);
  const usage = [usageOf(first)];
  let check =
    first.output === undefined
      ? { ok: false, output: null, problems: ["The response was not valid JSON."] }
      : checkFeatures(first.output);
  let repairUsed = false;
  if (!check.output) {
    const repaired = await analyzer.repair(
      {
        pass: "features",
        previousOutput: asText(first),
        problems: check.problems,
        model: first.model,
      },
      signal,
      { budget: ctx?.budget, timeoutMs: REPAIR_TIMEOUT_MS },
    );
    usage.push(usageOf(repaired));
    repairUsed = true;
    check =
      repaired.output === undefined
        ? { ok: false, output: null, problems: ["The repaired response was not valid JSON."] }
        : checkFeatures(repaired.output);
  }
  if (!check.output) {
    // The calls still cost tokens: the usage rides on the error so the pipeline counts it.
    throw new MatchCutError(
      "INVALID_MODEL_OUTPUT",
      {},
      { step: "features", problems: check.problems, repairUsed, usage },
    );
  }
  const grounded = groundFeatures(check.output, input.breakdown);
  return { values: grounded.values, ungrounded: grounded.ungrounded, repairUsed, usage };
}

/** A cached features entry, checked against the allowed values before use (shared, may be stale). */
export function readCachedFeatures(
  raw: string | null,
): { values: FeatureValues; ungrounded: number } | null {
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as { values?: Record<string, unknown>; ungrounded?: unknown };
    const v = entry.values;
    const ok =
      !!v &&
      MODEL_FEATURE_NAMES.every((f) => {
        const value = v[f];
        return (
          typeof value === "string" &&
          (value === UNKNOWN || (MODEL_FEATURES[f] as readonly string[]).includes(value))
        );
      });
    if (!ok) return null;
    return {
      values: v as FeatureValues,
      ungrounded: Array.isArray(entry.ungrounded) ? entry.ungrounded.length : 0,
    };
  } catch {
    return null;
  }
}

export interface WritingRun {
  check: PlaybookCheck;
  repairUsed: boolean;
  /** The writer call itself failed: every part came from code. */
  writerFailed: boolean;
  /** Why it failed, for logs and alerts (a billing problem is an ALERT). */
  writerError?: MatchCutError;
  usage: StepUsage[];
}

/**
 * Writes the playbook: one call, the checks, one repair when they find problems, and the better
 * of the two results (fewer problems). If the writer call itself fails, the playbook is built from
 * code: rules with fallback wording and no recipe. Only an abort escapes.
 */
export async function writeAndCheck(
  analyzer: VideoAnalyzer,
  input: { facts: PlaybookFacts; manifest: CapabilityManifest; language: string; model: string },
  onWritten: () => Promise<void>,
  signal?: AbortSignal,
  ctx?: CallContext,
  log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
): Promise<WritingRun> {
  const usage: StepUsage[] = [];
  let first: ModelResult;
  try {
    first = await analyzer.writePlaybook(input, signal, ctx);
  } catch (e) {
    if (signal?.aborted) throw e;
    const writerError = e instanceof MatchCutError ? e : new MatchCutError("INTERNAL");
    log("playbook writer failed; using code-written wording", { code: writerError.error.code });
    await onWritten();
    return {
      check: checkPlaybook(null, input.facts),
      repairUsed: false,
      writerFailed: true,
      writerError,
      usage,
    };
  }
  usage.push(usageOf(first));
  await onWritten();
  let check = checkPlaybook(first.output ?? null, input.facts, { language: input.language });
  let repairUsed = false;
  if (!check.ok) {
    try {
      const repaired = await analyzer.repair(
        {
          pass: "playbook",
          previousOutput: asText(first),
          problems: check.problems,
          model: first.model,
        },
        signal,
        { budget: ctx?.budget },
      );
      usage.push(usageOf(repaired));
      repairUsed = true;
      const second = checkPlaybook(repaired.output ?? null, input.facts, {
        language: input.language,
      });
      if (second.problems.length <= check.problems.length) check = second;
    } catch (e) {
      if (signal?.aborted) throw e;
      log("playbook repair failed; keeping the first wording with fallbacks", {
        code: e instanceof MatchCutError ? e.error.code : "INTERNAL",
      });
    }
  }
  return { check, repairUsed, writerFailed: false, usage };
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping the input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(lanes);
  return out;
}
