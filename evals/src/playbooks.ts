/**
 * Playbook evals (PRD-playbooks.md, "Quality evaluation" and the M10 done-when: "A playbook for
 * each of 10 golden channels passes faithfulness checks, and apply returns a valid prompt and shot
 * list"). Each case builds a playbook end to end with the real pipeline, then checks it in code:
 *
 * - outcome: the expected status or error code (and NOT_ENOUGH_DATA reasons);
 * - faithful: evidence and confidence equal the comparison, examples are real moments of
 *   breakouts carrying the value, counterexamples really break the rule;
 * - planted: every planted edit pattern reaches a rule (mock channels), and no other rule is high;
 * - warnings: the expected caveats are present;
 * - recipe: a recipe prompt template exists when there are rules;
 * - apply: apply returns a prompt that passes v1's prompt checks and a 4 to 15 shot list.
 *
 * People then score what code can't (RUBRIC.md, Playbooks): rule correctness, usefulness, honesty
 * of "not explained", originality of the recipe. Real channels need a human-written note first.
 */
import {
  faithfulnessProblems,
  SHOT_LIST_MAX,
  SHOT_LIST_MIN,
  type Breakdown,
  type CapabilityManifest,
  type FeatureName,
  type ModelNames,
  type PlaybookFacts,
  type Pricing,
} from "@match-cut/core";
import {
  MemoryBriefEvents,
  MemoryKV,
  MemoryPlaybookStore,
  type PlaybookRecord,
} from "@match-cut/infra";
import type { ChannelLookup, VideoAnalyzer } from "@match-cut/providers";
import { applyAndValidate } from "@match-cut/worker/pass2";
import { runPlaybookJob } from "@match-cut/worker/playbook-pipeline";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const feature = z.tuple([z.string(), z.string()]);

export const playbookCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  source: z.union([
    z.object({ type: z.literal("mock"), handle: z.string() }),
    z.object({ type: z.literal("channel"), channel: z.string().nullable() }),
  ]),
  category: z.string(),
  expect: z.object({
    outcome: z.string(),
    planted: z.array(feature).optional(),
    warnings: z.array(z.string()).optional(),
    reasons: z.array(z.string()).optional(),
  }),
  /** PRD: each golden channel has a human-written note on why its outliers worked. */
  note: z.string(),
  note_by: z.string(),
  status: z.enum(["ready", "needs_channel", "needs_note"]),
});
export type PlaybookCase = z.infer<typeof playbookCaseSchema>;

export const playbookSetSchema = z.object({
  target_size: z.number(),
  /** Fixed clock for mock channels, so every run sees the same uploads. */
  as_of: z.string(),
  /** What apply is asked for in every case. */
  apply: z.object({
    goal: z.string(),
    format: z.enum(["9:16", "16:9", "1:1", "4:5", "match"]),
    length_seconds: z.number().int().nullable(),
  }),
  cases: z.array(playbookCaseSchema),
});
export type PlaybookSet = z.infer<typeof playbookSetSchema>;

export interface LoadedPlaybookCase {
  case: PlaybookCase;
  /** Why the case won't run, if it won't. */
  skip?: string;
}

export function loadPlaybookSet(
  dir: string,
  provider: "mock" | "gemini",
): PlaybookSet & { loaded: LoadedPlaybookCase[] } {
  const set = playbookSetSchema.parse(JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")));
  const loaded = set.cases.map((c): LoadedPlaybookCase => {
    if (c.status === "needs_channel" || (c.source.type === "channel" && !c.source.channel)) {
      return { case: c, skip: "no channel picked yet" };
    }
    if (c.status === "needs_note" || !c.note.trim() || !c.note_by.trim()) {
      return { case: c, skip: "needs a human-written note" };
    }
    // Mock channels exist only offline; real ones only with the real YouTube API.
    if (provider === "mock" && c.source.type === "channel") {
      return { case: c, skip: "real channel: run with --provider gemini" };
    }
    if (provider === "gemini" && c.source.type === "mock") {
      return { case: c, skip: "mock channel: run with --provider mock" };
    }
    return { case: c };
  });
  return { ...set, loaded };
}

export const PLAYBOOK_CHECKS = [
  "outcome",
  "faithful",
  "planted",
  "warnings",
  "recipe",
  "apply",
] as const;
export type PlaybookCheck = (typeof PLAYBOOK_CHECKS)[number];

export interface PlaybookCaseResult {
  id: string;
  category: string;
  skipped?: string;
  status: string | null;
  errorCode: string | null;
  /** null: the check doesn't apply to this case (e.g. apply on NOT_ENOUGH_DATA). */
  checks: Record<PlaybookCheck, boolean | null>;
  problems: string[];
  rules: {
    title: string;
    feature: string;
    value: string;
    confidence: string;
    evidence: string;
  }[];
  houseStyle: string | null;
  notExplained: string[];
  warnings: string[];
  recipe: string | null;
  applyPrompt: string | null;
  shots: number | null;
  note: string;
  costUsd: number;
  ms: number;
}

export interface PlaybookRunDeps {
  analyzer: VideoAnalyzer;
  channels: ChannelLookup;
  manifest: CapabilityManifest;
  models: ModelNames;
  pricing?: Pricing;
  now: () => number;
  log?: (msg: string) => void;
}

const evidence = (r: NonNullable<PlaybookRecord["content"]>["rules"][number]) =>
  `${r.evidence.outliers_with} of ${r.evidence.outliers_known} breakouts · ${r.evidence.typical_with} of ${r.evidence.typical_known} typical`;

/** The facts a stored playbook was written from, rebuilt for the independent faithfulness check. */
function factsOf(pb: PlaybookRecord): PlaybookFacts {
  const c = pb.comparison!;
  const duration = new Map(pb.videos.map((v) => [v.id, v.durationSeconds]));
  return {
    rules: c.rules,
    houseStyle: c.houseStyle,
    outlierTopics: c.outlierTopics,
    outliers: c.features
      .filter((f) => f.group === "outlier")
      .map((f) => ({
        videoId: f.videoId,
        analyzedSeconds: duration.get(f.videoId) ?? 0,
        features: f.features,
        // Not used by the faithfulness check.
        breakdown: {} as Breakdown,
      })),
  };
}

export async function runPlaybookCase(
  loaded: LoadedPlaybookCase,
  set: Pick<PlaybookSet, "apply">,
  deps: PlaybookRunDeps,
): Promise<PlaybookCaseResult> {
  const c = loaded.case;
  const base: PlaybookCaseResult = {
    id: c.id,
    category: c.category,
    status: null,
    errorCode: null,
    checks: {
      outcome: null,
      faithful: null,
      planted: null,
      warnings: null,
      recipe: null,
      apply: null,
    },
    problems: [],
    rules: [],
    houseStyle: null,
    notExplained: [],
    warnings: [],
    recipe: null,
    applyPrompt: null,
    shots: null,
    note: c.note,
    costUsd: 0,
    ms: 0,
  };
  if (loaded.skip) return { ...base, skipped: loaded.skip };

  // A fresh store and cache per case: nothing carries over from one channel to the next.
  const store = new MemoryPlaybookStore();
  const at = new Date(deps.now());
  const record: PlaybookRecord = {
    id: `eval_${c.id}`,
    userId: "eval",
    orgId: "eval",
    status: "queued",
    stage: null,
    progress: null,
    source:
      c.source.type === "mock"
        ? { kind: "handle", handle: c.source.handle }
        : { kind: "handle", handle: c.source.channel!.replace(/^@/, "") },
    settings: { windowDays: 90, maxVideos: 50, outlierThreshold: 2 },
    forceRefresh: true,
    channel: null,
    window: null,
    baseline: null,
    notEnoughData: null,
    videos: [],
    comparison: null,
    content: null,
    spokenLines: null,
    warnings: [],
    error: null,
    meta: { models: {}, versions: {}, cached: false, timingsMs: {}, tokens: {} },
    createdAt: at,
    updatedAt: at,
  };
  await store.create(record);
  const started = Date.now();
  await runPlaybookJob(
    { playbookId: record.id },
    {
      store,
      kv: new MemoryKV(deps.now),
      events: new MemoryBriefEvents(),
      channels: deps.channels,
      analyzer: deps.analyzer,
      manifest: deps.manifest,
      models: deps.models,
      pricing: deps.pricing,
      now: deps.now,
    },
  );
  const pb = (await store.get(record.id))!;
  const r: PlaybookCaseResult = {
    ...base,
    status: pb.status,
    errorCode: pb.error?.code ?? null,
    warnings: pb.warnings.map((w) => w.code),
    costUsd: pb.meta.costUsd ?? 0,
    ms: Date.now() - started,
  };
  const problem = (check: PlaybookCheck, text: string) => r.problems.push(`${check}: ${text}`);

  // Outcome: succeeded, or the expected error code (and NOT_ENOUGH_DATA reasons).
  const got = pb.status === "succeeded" ? "succeeded" : (pb.error?.code ?? pb.status);
  r.checks.outcome = got === c.expect.outcome;
  if (!r.checks.outcome) problem("outcome", `expected ${c.expect.outcome}, got ${got}`);
  if (c.expect.reasons) {
    const reasons = pb.notEnoughData?.reasons ?? [];
    const missing = c.expect.reasons.filter((x) => !reasons.includes(x as never));
    if (missing.length) {
      r.checks.outcome = false;
      problem("outcome", `missing reasons ${missing.join(", ")}`);
    }
  }
  if (pb.status !== "succeeded" || !pb.content || !pb.comparison) return r;

  const content = pb.content;
  r.rules = content.rules.map((x) => ({
    title: x.title,
    feature: x.feature,
    value: x.value,
    confidence: x.confidence,
    evidence: evidence(x),
  }));
  r.houseStyle = content.house_style || null;
  r.notExplained = content.not_explained;
  r.recipe = content.recipe_prompt_template;

  // Faithfulness, checked again from the stored record, independently of the pipeline's check.
  const facts = factsOf(pb);
  const unfaithful = faithfulnessProblems({ ...content, warnings: [] }, facts);
  r.checks.faithful = unfaithful.length === 0;
  for (const u of unfaithful) problem("faithful", u);

  // Planted patterns (mock channels): each one is a rule; nothing else reaches high confidence.
  if (c.expect.planted) {
    const planted = new Set(c.expect.planted.map(([f, v]) => `${f}=${v}`));
    const keys = new Set(content.rules.map((x) => `${x.feature}=${x.value}`));
    const missing = [...planted].filter((k) => !keys.has(k));
    const intruders = content.rules
      .filter((x) => x.confidence === "high" && !planted.has(`${x.feature}=${x.value}`))
      .map((x) => `${x.feature}=${x.value}`);
    r.checks.planted = missing.length === 0 && intruders.length === 0;
    if (missing.length) problem("planted", `not found: ${missing.join(", ")}`);
    if (intruders.length)
      problem("planted", `high-confidence rules not planted: ${intruders.join(", ")}`);
  }

  if (c.expect.warnings) {
    const missing = c.expect.warnings.filter((w) => !r.warnings.includes(w));
    r.checks.warnings = missing.length === 0;
    if (missing.length) problem("warnings", `missing ${missing.join(", ")}`);
  }

  if (content.rules.length === 0) return r;
  r.checks.recipe = content.recipe_prompt_template !== null;
  if (!r.checks.recipe) problem("recipe", "no recipe prompt template");

  // Apply: a prompt that passes v1's checks (applyAndValidate throws otherwise) and a shot list.
  try {
    const run = await applyAndValidate(
      deps.analyzer,
      {
        recipe: {
          rules: content.rules.map((x) => ({
            feature: x.feature as FeatureName,
            value: x.value,
            title: x.title,
            how_to: x.how_to,
          })),
          houseStyle: content.house_style,
          template: content.recipe_prompt_template,
        },
        goal: set.apply.goal,
        format: set.apply.format,
        lengthSeconds: set.apply.length_seconds,
        language: "en",
        manifest: deps.manifest,
        model: deps.models.pass2,
      },
      { spokenLines: pb.spokenLines ?? [], spokenFingerprints: [] },
    );
    r.applyPrompt = run.output.cardboard_prompt;
    r.shots = run.output.shot_list.length;
    const shotsOk = !run.shotListDropped && r.shots >= SHOT_LIST_MIN && r.shots <= SHOT_LIST_MAX;
    r.checks.apply = shotsOk;
    if (!shotsOk)
      problem("apply", `shot list ${run.shotListDropped ? "dropped" : `has ${r.shots} shots`}`);
  } catch (e) {
    r.checks.apply = false;
    problem("apply", e instanceof Error ? e.message : String(e));
  }
  return r;
}

export async function runPlaybookSet(
  set: PlaybookSet & { loaded: LoadedPlaybookCase[] },
  deps: PlaybookRunDeps,
): Promise<PlaybookCaseResult[]> {
  const out: PlaybookCaseResult[] = [];
  for (const c of set.loaded) {
    const r = await runPlaybookCase(c, set, deps);
    deps.log?.(`${r.id}: ${r.skipped ? `skipped (${r.skipped})` : passed(r) ? "ok" : "FAIL"}`);
    out.push(r);
  }
  return out;
}

export const passed = (r: PlaybookCaseResult) =>
  !r.skipped && Object.values(r.checks).every((v) => v !== false);

export interface PlaybookSummary {
  ran: number;
  skipped: number;
  passed: number;
  /** Per check: cases where it applied, and how many passed. */
  checks: Record<PlaybookCheck, { applied: number; passed: number }>;
  costUsd: number;
}

export function summarizePlaybooks(results: PlaybookCaseResult[]): PlaybookSummary {
  const ran = results.filter((r) => !r.skipped);
  const checks = Object.fromEntries(
    PLAYBOOK_CHECKS.map((k) => {
      const applied = ran.filter((r) => r.checks[k] !== null);
      return [k, { applied: applied.length, passed: applied.filter((r) => r.checks[k]).length }];
    }),
  ) as PlaybookSummary["checks"];
  return {
    ran: ran.length,
    skipped: results.length - ran.length,
    passed: ran.filter(passed).length,
    checks,
    costUsd: ran.reduce((s, r) => s + r.costUsd, 0),
  };
}

const mark = (v: boolean | null) => (v === null ? "–" : v ? "✓" : "✗");

export function playbookReport(
  info: {
    startedAt: string;
    provider: string;
    targetSize: number;
    versions: Record<string, string>;
  },
  summary: PlaybookSummary,
  results: PlaybookCaseResult[],
): string {
  const lines = [
    `# Playbook eval: ${info.provider}`,
    "",
    `Run ${info.startedAt}. Versions: ${Object.entries(info.versions)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}.`,
    "",
    `**${summary.passed} of ${summary.ran} cases passed** (${summary.skipped} skipped; set has ${results.length} of a target ${info.targetSize}).${info.provider === "mock" ? " Mock mode: no model cost." : ` Model cost $${summary.costUsd.toFixed(4)}.`}`,
    "",
    "| Check | Passed |",
    "| --- | --- |",
    ...PLAYBOOK_CHECKS.map(
      (k) => `| ${k} | ${summary.checks[k].passed} of ${summary.checks[k].applied} |`,
    ),
    "",
    "## Cases",
    "",
    `| Case | Category | ${PLAYBOOK_CHECKS.join(" | ")} | Rules |`,
    `| --- | --- | ${PLAYBOOK_CHECKS.map(() => "---").join(" | ")} | --- |`,
    ...results.map((r) =>
      r.skipped
        ? `| ${r.id} | ${r.category} | ${PLAYBOOK_CHECKS.map(() => "–").join(" | ")} | skipped: ${r.skipped} |`
        : `| ${r.id} | ${r.category} | ${PLAYBOOK_CHECKS.map((k) => mark(r.checks[k])).join(" | ")} | ${r.rules.length} |`,
    ),
  ];
  const failed = results.filter((r) => !r.skipped && !passed(r));
  if (failed.length) {
    lines.push("", "## Failures", "");
    for (const r of failed) lines.push(`- **${r.id}**: ${r.problems.join("; ")}`);
  }
  return lines.join("\n") + "\n";
}

/** For people: what code can't score (RUBRIC.md, Playbooks). */
export function playbookReviewSheet(results: PlaybookCaseResult[]): string {
  const lines = [
    "# Playbook review sheet",
    "",
    "Score each criterion 1 to 5: rule correctness (do the rules match the note?), usefulness (could an editor act on them?), honesty of what the edit doesn't explain, originality of the recipe (craft, not the channel's content).",
  ];
  for (const r of results.filter((x) => !x.skipped && x.status === "succeeded")) {
    lines.push(
      "",
      `## ${r.id} (${r.category})`,
      "",
      `Note: ${r.note}`,
      "",
      "Rules:",
      ...(r.rules.length
        ? r.rules.map((x) => `- ${x.title} (${x.confidence}; ${x.evidence})`)
        : ["- none"]),
      "",
      `House style: ${r.houseStyle ?? "none"}`,
      "",
      "Not explained:",
      ...r.notExplained.map((x) => `- ${x}`),
      "",
      "Recipe:",
      "",
      "```",
      r.recipe ?? "(none)",
      "```",
      "",
      "| Correctness | Usefulness | Honesty | Originality | Comment |",
      "| --- | --- | --- | --- | --- |",
      "|  |  |  |  |  |",
    );
  }
  return lines.join("\n") + "\n";
}
