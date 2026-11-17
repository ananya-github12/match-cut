/**
 * Runs eval cases through the same pass 1 and pass 2 code the worker uses (watchAndValidate,
 * writeAndValidate), then scores them. PRD: "Offline evaluation: golden set".
 */
import {
  canonicalYouTubeUrl,
  costUsd,
  parseYouTubeSource,
  type CapabilityManifest,
  type ModelNames,
  type Pricing,
} from "@match-cut/core";
import type { VideoAnalyzer, VideoLookup } from "@match-cut/providers";
import { watchAndValidate } from "@match-cut/worker/pass1";
import { writeAndValidate } from "@match-cut/worker/pass2";
import type { Judge } from "./judge.js";
import { adaptationChecks, mapStepsToOperations, originality, specificity } from "./score.js";
import type { CaseResult, CriterionName, CriterionResult, LoadedCase } from "./types.js";

export const BARS = {
  accuracyMaxWrong: 0.05,
  specificityMin: 6,
  adaptationMinShare: 0.9,
} as const;

export interface RunDeps {
  analyzer: VideoAnalyzer;
  judge: Judge;
  manifest: CapabilityManifest;
  models: ModelNames;
  lookup?: VideoLookup;
  pricing?: Pricing;
  log?: (msg: string) => void;
}

export async function runCase(lc: LoadedCase, deps: RunDeps): Promise<CaseResult> {
  const c = lc.case;
  const base = { id: c.id, category: c.category };
  if (lc.skip) return { ...base, status: "skipped", skip: lc.skip };
  const parsed = parseYouTubeSource(c.url ?? "");
  if (!parsed.ok) return { ...base, status: "error", error: parsed.code };
  const started = Date.now();
  try {
    let duration: number | null = null;
    if (deps.lookup) {
      const r = await deps.lookup.lookup(parsed.videoId);
      if (r.status === "found") duration = r.video.durationSeconds;
    }
    const range = c.clip ?? null;
    const analyzed = range ? range.end_seconds - range.start_seconds : duration;
    const model = c.detail === "deep" ? deps.models.deep : deps.models.standard;
    const p1 = await watchAndValidate(
      deps.analyzer,
      {
        videoId: parsed.videoId,
        canonicalUrl: canonicalYouTubeUrl(parsed.videoId),
        range,
        detail: c.detail,
        model,
        durationSeconds: duration,
      },
      analyzed,
    );
    const { spoken_lines_internal, ...breakdown } = p1.output;
    const p2 = await writeAndValidate(
      deps.analyzer,
      {
        breakdown,
        goal: c.goal,
        format: c.target.format,
        lengthSeconds: c.target.length_seconds,
        language: c.language,
        manifest: deps.manifest,
        model: deps.models.pass2,
      },
      spoken_lines_internal,
    );
    const prompt = p2.output.cardboard_prompt;
    const promptAndLists = [prompt, ...p2.output.assets_needed, ...p2.output.watch_outs].join("\n");

    const judged = await deps.judge.evaluate({
      evalCase: c,
      reference: lc.reference,
      breakdown,
      prompt,
      manifest: deps.manifest,
    });

    const counts = { consistent: 0, contradicted: 0, unverifiable: 0 };
    for (const o of judged.observations) counts[o.verdict]++;
    const judgedObs = counts.consistent + counts.contradicted;
    const wrongRate = judgedObs ? counts.contradicted / judgedObs : null;

    const spec = specificity(breakdown);
    const steps = judged.steps.length ? judged.steps : mapStepsToOperations(prompt, deps.manifest);
    const unmapped = steps.filter((s) => !s.operation);
    const opIds = new Set(deps.manifest.operations.map((o) => o.id));
    const unknownOps = steps.filter((s) => s.operation && !opIds.has(s.operation));
    const adapt = adaptationChecks(prompt, c, breakdown);
    const orig = originality(promptAndLists, spoken_lines_internal, lc.reference);

    const criteria: Record<CriterionName, CriterionResult> = {
      accuracy: {
        pass: wrongRate === null ? null : wrongRate < BARS.accuracyMaxWrong,
        value: wrongRate ?? undefined,
        detail: `${counts.contradicted} contradicted, ${counts.consistent} consistent, ${counts.unverifiable} unverifiable`,
      },
      specificity: {
        pass: spec.count >= BARS.specificityMin,
        value: spec.count,
        detail: spec.examples.join(", "),
      },
      executability: {
        pass: steps.length > 0 && unmapped.length === 0 && unknownOps.length === 0,
        value: steps.length
          ? (steps.length - unmapped.length - unknownOps.length) / steps.length
          : 0,
        detail:
          [...unmapped, ...unknownOps].map((s) => `step ${s.step}`).join(", ") ||
          "all steps mapped",
      },
      adaptation: {
        pass: judged.adapted && adapt.pass,
        detail: [judged.adaptation_reason, ...adapt.failed].filter(Boolean).join("; "),
      },
      originality: {
        pass: orig.pass && judged.copied.length === 0,
        value: orig.sharedRun,
        detail:
          [
            orig.sharedRun > 12 ? `${orig.sharedRun} words copied from speech` : "",
            ...orig.brandHits.map((b) => `brand term "${b}"`),
            ...judged.copied.map((x) => `judge: "${x}"`),
          ]
            .filter(Boolean)
            .join("; ") || "nothing copied",
      },
      honesty: {
        // PRD: reviewer spot-check. Flags go to the human review sheet; they don't fail the gate.
        pass: judged.invented.length === 0,
        value: JSON.stringify(breakdown).split('"unclear"').length - 1,
        detail: judged.invented.join("; ") || "nothing flagged",
      },
    };

    const tokens = {
      pass1_input: p1.tokens.input,
      pass1_output: p1.tokens.output,
      pass2_input: p2.tokens.input,
      pass2_output: p2.tokens.output,
    };
    const cost = deps.pricing
      ? costUsd(deps.pricing, p1.model, p1.tokens) + costUsd(deps.pricing, p2.model, p2.tokens)
      : undefined;
    return {
      ...base,
      status: "scored",
      criteria,
      accuracyCounts: counts,
      breakdown,
      prompt,
      models: { pass1: p1.model, pass2: p2.model },
      repairs: { pass1: p1.repairUsed, pass2: p2.repairUsed },
      tokens,
      costUsd: cost,
      seconds: (Date.now() - started) / 1000,
      judgeNotes: judged.observations
        .filter((o) => o.verdict === "contradicted")
        .map((o) => `${o.field}: ${o.reason}`),
    };
  } catch (e) {
    const err = e as { error?: { code: string }; message?: string };
    return { ...base, status: "error", error: err.error?.code ?? err.message ?? String(e) };
  }
}

export interface SetSummary {
  cases: number;
  scored: number;
  skipped: number;
  errors: number;
  criteria: Record<
    CriterionName,
    { passRate: number | null; scored: number; meetsBar: boolean | null; aggregate?: number }
  >;
  costUsd: number;
}

export function summarize(results: CaseResult[]): SetSummary {
  const scored = results.filter((r) => r.status === "scored");
  const names: CriterionName[] = [
    "accuracy",
    "specificity",
    "executability",
    "adaptation",
    "originality",
    "honesty",
  ];
  const criteria = Object.fromEntries(
    names.map((n) => {
      const vals = scored.map((r) => r.criteria![n].pass).filter((p): p is boolean => p !== null);
      const passRate = vals.length ? vals.filter(Boolean).length / vals.length : null;
      let meetsBar: boolean | null = passRate === null ? null : passRate === 1;
      let aggregate: number | undefined;
      if (n === "accuracy") {
        // PRD: under 5% of observations wrong, across the set.
        const c = scored.reduce(
          (a, r) => ({
            wrong: a.wrong + (r.accuracyCounts?.contradicted ?? 0),
            judged:
              a.judged +
              (r.accuracyCounts?.contradicted ?? 0) +
              (r.accuracyCounts?.consistent ?? 0),
          }),
          { wrong: 0, judged: 0 },
        );
        aggregate = c.judged ? c.wrong / c.judged : undefined;
        meetsBar = aggregate === undefined ? null : aggregate < BARS.accuracyMaxWrong;
      }
      if (n === "adaptation" && passRate !== null) meetsBar = passRate >= BARS.adaptationMinShare;
      if (n === "honesty") meetsBar = null; // reviewer spot-check
      return [
        n,
        {
          passRate,
          scored: vals.length,
          meetsBar,
          ...(aggregate !== undefined ? { aggregate } : {}),
        },
      ];
    }),
  ) as SetSummary["criteria"];
  return {
    cases: results.length,
    scored: scored.length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: results.filter((r) => r.status === "error").length,
    criteria,
    costUsd: scored.reduce((a, r) => a + (r.costUsd ?? 0), 0),
  };
}

export async function runSet(cases: LoadedCase[], deps: RunDeps): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const lc of cases) {
    deps.log?.(`${lc.case.id}${lc.skip ? ` (skipped: ${lc.skip})` : ""}`);
    out.push(await runCase(lc, deps));
  }
  return out;
}
