/**
 * Apply (PRD-playbooks.md, API additions and Feature 4): one synchronous text step that writes a
 * prompt and shot list for the user's goal, format, length and language, from a playbook's rules
 * or a saved skill. Cost is "the same as a v1 regenerate", so it takes a regenerate slot, checks
 * the spend cap, is cached for 7 days, and gives the slot back when the failure isn't the user's.
 */
import { createHash } from "node:crypto";
import {
  APPLY_PROMPT_VERSION,
  costUsd,
  MatchCutError,
  PASS2_PROMPT_VERSION,
  PASS2_TTL_SECONDS,
  pass2OutputSchema,
  warning,
  type ApplyRecipe,
  type ApplyRequest,
  type ApplyResponse,
  type Breakdown,
  type CapabilityManifest,
  type ModelNames,
  type Pricing,
} from "@match-cut/core";
import type { KV, RateLimiter, SpendTracker, Who } from "@match-cut/infra";
import { JobBudget, type VideoAnalyzer } from "@match-cut/providers";
import { applyAndValidate, writeAndValidate } from "@match-cut/worker/pass2";

export interface ApplyDeps {
  kv: KV;
  analyzer: VideoAnalyzer;
  models: ModelNames;
  manifest: CapabilityManifest;
  limiter?: RateLimiter;
  spend?: SpendTracker;
  pricing?: Pricing;
  /** Per-call budget, as a brief's pass 2. */
  budget?: { maxFailedAttempts: number; timeoutMs: number };
}

/** What the prompt is written from: a playbook's rules, or a brief skill's breakdown. */
export type ApplySource =
  { type: "recipe"; recipe: ApplyRecipe } | { type: "breakdown"; breakdown: Breakdown };

/**
 * Failures that aren't the user's: the regenerate slot goes back. Unlike v1's job refund,
 * INVALID_MODEL_OUTPUT isn't here: apply is synchronous and its input is the user's goal, so a
 * goal that always breaks the output would otherwise buy unlimited paid calls.
 */
const NOT_USERS_FAULT = new Set([
  "UPSTREAM_ERROR",
  "UPSTREAM_TIMEOUT",
  "CAPACITY_EXHAUSTED",
  "INTERNAL",
]);

export async function runApply(
  deps: ApplyDeps,
  who: Who,
  slotTakenAt: Date,
  source: ApplySource,
  body: ApplyRequest,
  copyCheck: { spokenLines: string[]; spokenFingerprints: readonly string[] },
  /** Aborted when the client disconnects, so a gone caller doesn't keep paying for calls. */
  signal?: AbortSignal,
): Promise<ApplyResponse> {
  const model = deps.models.pass2;
  const goal = body.goal?.trim() ?? "";
  const lengthSeconds = body.target.length_seconds ?? null;
  const version = source.type === "recipe" ? APPLY_PROMPT_VERSION : PASS2_PROMPT_VERSION;
  const key = `apply:${createHash("sha256")
    .update(
      JSON.stringify([
        version,
        model,
        deps.manifest.manifest_version,
        source,
        // The copy check the output passed is part of what was cached.
        createHash("sha256")
          .update(JSON.stringify([copyCheck.spokenLines, copyCheck.spokenFingerprints]))
          .digest("hex"),
        goal,
        // For playbooks, "match" means the channel's vertical 9:16.
        source.type === "recipe" && body.target.format === "match" ? "9:16" : body.target.format,
        lengthSeconds,
        body.output_language,
      ]),
    )
    .digest("hex")
    .slice(0, 32)}`;

  const hit = await deps.kv.get(key);
  if (hit) {
    const parsed = (() => {
      try {
        return pass2OutputSchema.safeParse(JSON.parse(hit));
      } catch {
        return null;
      }
    })();
    if (parsed?.success) {
      return {
        ...parsed.data,
        warnings: [],
        meta: { model, prompt_version: version, cached: true, tokens: {} },
      };
    }
  }

  const refund = () => deps.limiter?.refund("regenerate", who, slotTakenAt);
  if (deps.spend && (await deps.spend.overCap())) {
    await refund();
    throw new MatchCutError("CAPACITY_EXHAUSTED", {}, { reason: "spend_cap" });
  }

  const budget = new JobBudget({
    maxFailedAttempts: deps.budget?.maxFailedAttempts ?? 4,
    timeoutMs: deps.budget?.timeoutMs ?? 60_000,
  });
  let run;
  try {
    run =
      source.type === "recipe"
        ? await applyAndValidate(
            deps.analyzer,
            {
              recipe: source.recipe,
              goal,
              format: body.target.format,
              lengthSeconds,
              language: body.output_language,
              manifest: deps.manifest,
              model,
            },
            copyCheck,
            signal,
            { budget },
          )
        : await writeAndValidate(
            deps.analyzer,
            {
              breakdown: source.breakdown,
              goal,
              format: body.target.format,
              lengthSeconds,
              language: body.output_language,
              manifest: deps.manifest,
              model,
            },
            copyCheck.spokenLines,
            signal,
            undefined,
            { budget },
            copyCheck.spokenFingerprints,
          );
  } catch (e) {
    // Calls that failed still cost tokens: count them toward the daily spend.
    const usage = e instanceof MatchCutError ? e.detail?.usage : undefined;
    if (deps.pricing && usage && typeof usage === "object") {
      const u = usage as { model: string; tokens: { input: number; output: number } };
      await deps.spend?.add(costUsd(deps.pricing, u.model, u.tokens));
    }
    if (e instanceof MatchCutError && NOT_USERS_FAULT.has(e.error.code)) await refund();
    throw e;
  }
  if (deps.pricing) {
    await deps.spend?.add(costUsd(deps.pricing, run.model, run.tokens));
  }
  if (!run.fallbackUsed && !run.shotListDropped) {
    await deps.kv.set(key, JSON.stringify(run.output), PASS2_TTL_SECONDS);
  }
  return {
    ...run.output,
    warnings: run.shotListDropped ? [warning("SHOT_LIST_UNAVAILABLE")] : [],
    meta: {
      model: run.model,
      prompt_version: version,
      cached: false,
      tokens: { input: run.tokens.input, output: run.tokens.output },
    },
  };
}
