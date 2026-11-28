/**
 * Eval runner.
 *
 *   pnpm eval                       smoke set, mock provider, mock judge (free, offline)
 *   pnpm eval --set golden --provider gemini --judge gemini --yes
 *   pnpm eval --set playbooks       playbooks for the golden channels, mock mode (free, offline)
 *   options: --only <case id>  --gate  --update-baseline  --review
 *
 * Real runs call the paid Gemini API (two passes per case, plus the judge) and need --yes.
 */
import {
  loadEnv,
  loadManifest,
  loadPricing,
  modelNames,
  PASS1_PROMPT_VERSION,
  PASS2_PROMPT_VERSION,
  SCHEMA_VERSION,
} from "@match-cut/core";
import {
  GeminiAnalyzer,
  MockAnalyzer,
  MockVideoLookup,
  withFallback,
  YouTubeDataApiLookup,
} from "@match-cut/providers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GeminiJudge, MockJudge } from "./judge.js";
import {
  gate,
  markdownReport,
  reviewSheet,
  toBaseline,
  type Baseline,
  type RunInfo,
} from "./report.js";
import { runSet, summarize } from "./run.js";
import { loadSet } from "./types.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) =>
  args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined;

const setName = opt("set") ?? "smoke";
const provider = opt("provider") ?? "mock";
const judgeName = opt("judge") ?? "mock";
if (setName === "playbooks") {
  await runPlaybooks();
  process.exit(process.exitCode ?? 0);
}
if (
  !["smoke", "golden"].includes(setName) ||
  !["mock", "gemini"].includes(provider) ||
  !["mock", "gemini"].includes(judgeName)
) {
  console.error(
    "Usage: pnpm eval [--set smoke|golden|playbooks] [--provider mock|gemini] [--judge mock|gemini] [--only id] [--gate] [--update-baseline] [--review] [--yes]",
  );
  process.exit(2);
}

const env = loadEnv();
const manifest = loadManifest();
const pricing = loadPricing();
const { targetSize, cases: all } = loadSet(`${ROOT}${setName}`);
const only = opt("only");
const cases = only ? all.filter((c) => c.case.id === only) : all;
const runnable = cases.filter((c) => !c.skip);

const useGemini = provider === "gemini" || judgeName === "gemini";
if (useGemini) {
  if (!env.GEMINI_API_KEY || !env.GEMINI_MODEL_STANDARD) {
    console.error("Set GEMINI_API_KEY and the GEMINI_MODEL_* variables in .env first.");
    process.exit(2);
  }
  // Rough estimate: ~300 tokens per video second at default resolution, plus pass 2 and the judge.
  const est = runnable.length * 0.02;
  console.log(
    `${runnable.length} runnable cases; estimated cost about $${est.toFixed(2)} (paid Gemini calls).`,
  );
  if (!flag("yes")) {
    console.error("This calls the paid Gemini API. Re-run with --yes to proceed.");
    process.exit(2);
  }
}

const models =
  provider === "gemini"
    ? modelNames({ ...env, PROVIDER: "gemini" })
    : modelNames({ ...env, PROVIDER: "mock" });
const analyzer =
  provider === "gemini"
    ? withFallback(new GeminiAnalyzer({ apiKey: env.GEMINI_API_KEY! }), {
        fallbacks: models.fallbacks,
      })
    : new MockAnalyzer();
const lookup =
  provider === "gemini"
    ? env.YOUTUBE_DATA_API_KEY
      ? new YouTubeDataApiLookup({ apiKey: env.YOUTUBE_DATA_API_KEY })
      : undefined
    : new MockVideoLookup();
const judge =
  judgeName === "gemini"
    ? new GeminiJudge(
        env.GEMINI_API_KEY!,
        process.env.EVAL_JUDGE_MODEL ?? env.GEMINI_MODEL_DEEP ?? env.GEMINI_MODEL_STANDARD!,
      )
    : new MockJudge();

const info: RunInfo = {
  set: setName,
  startedAt: new Date().toISOString(),
  provider,
  judge: judge.name,
  models: { standard: models.standard, deep: models.deep, pass2: models.pass2 },
  versions: {
    pass1: PASS1_PROMPT_VERSION,
    pass2: PASS2_PROMPT_VERSION,
    schema: SCHEMA_VERSION,
    manifest: manifest.manifest_version,
  },
  targetSize,
};

const results = await runSet(cases, {
  analyzer,
  judge,
  manifest,
  models,
  lookup,
  pricing,
  log: (m) => console.log(`  ${m}`),
});
const summary = summarize(results);

const baselinePath = `${ROOT}baseline.${setName}.json`;
const baseline: Baseline | null = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : null;
const gateResult = flag("gate") ? gate(summary, baseline) : null;

const outDir = `${ROOT}reports/${info.startedAt.replace(/[:.]/g, "-")}-${setName}-${provider}`;
mkdirSync(outDir, { recursive: true });
writeFileSync(
  `${outDir}/report.json`,
  JSON.stringify({ info, summary, gate: gateResult, results }, null, 2) + "\n",
);
writeFileSync(`${outDir}/report.md`, markdownReport(info, summary, results, gateResult));
if (flag("review")) writeFileSync(`${outDir}/review.md`, reviewSheet(results));
if (flag("update-baseline")) {
  if (provider === "mock" && setName === "golden") {
    console.error("Refusing to write a golden baseline from mock output.");
  } else {
    writeFileSync(baselinePath, JSON.stringify(toBaseline(info, summary), null, 2) + "\n");
    console.log(`Baseline written: ${baselinePath}`);
  }
}

console.log(markdownReport(info, summary, results, gateResult).split("## Cases")[0]);
console.log(`Report: ${outDir}/report.md`);
if (gateResult && !gateResult.ok) process.exit(1);

/**
 * Playbook evals (PRD-playbooks.md, Quality evaluation). Mock mode runs the 10 golden mock
 * channels and the edge channels offline. Real channels need --provider gemini and --yes: each
 * watches up to 10 Shorts with the paid Gemini API and uses YouTube Data API quota.
 */
async function runPlaybooks() {
  const {
    loadPlaybookSet,
    playbookReport,
    playbookReviewSheet,
    runPlaybookSet,
    summarizePlaybooks,
  } = await import("./playbooks.js");
  const { COMPARISON_VERSION, FEATURES_VERSION, PLAYBOOK_VERSION } =
    await import("@match-cut/core");
  const { CachedChannelLookup, MockChannelLookup, YouTubeDataApiChannelLookup } =
    await import("@match-cut/providers");
  const { MemoryKV } = await import("@match-cut/infra");
  if (provider !== "mock" && provider !== "gemini") {
    console.error(
      "Usage: pnpm eval --set playbooks [--provider mock|gemini] [--only id] [--gate] [--review] [--yes]",
    );
    process.exit(2);
  }
  // Loaded here: this runs before the brief evals' module-level setup.
  const env = loadEnv();
  const manifest = loadManifest();
  const pricing = loadPricing();
  const set = loadPlaybookSet(`${ROOT}playbooks`, provider);
  const only = opt("only");
  if (only) {
    set.loaded = set.loaded.filter((c) => c.case.id === only);
    if (set.loaded.length === 0) {
      console.error(`No playbook case "${only}" in evals/playbooks/cases.json.`);
      process.exit(2);
    }
  }
  const runnable = set.loaded.filter((c) => !c.skip);
  if (provider === "gemini") {
    if (!env.GEMINI_API_KEY || !env.YOUTUBE_DATA_API_KEY) {
      console.error("Set GEMINI_API_KEY and YOUTUBE_DATA_API_KEY in .env first.");
      process.exit(2);
    }
    // Per channel: up to 10 Shorts watched (pass 1) and read for features, then writing and
    // apply; a failed check adds one repair call. Plus a few YouTube Data API reads.
    console.log(
      `${runnable.length} real channels; each makes about 22 paid Gemini calls (10 Shorts watched), more if repairs are needed.`,
    );
    if (!flag("yes")) {
      console.error("This calls the paid Gemini API. Re-run with --yes to proceed.");
      process.exit(2);
    }
  }
  // Mock channels are generated relative to "now": a fixed clock keeps every run identical.
  const now = provider === "mock" ? () => Date.parse(set.as_of) : Date.now;
  const models =
    provider === "gemini"
      ? modelNames({ ...env, PROVIDER: "gemini" })
      : modelNames({ ...env, PROVIDER: "mock" });
  const analyzer =
    provider === "gemini"
      ? withFallback(new GeminiAnalyzer({ apiKey: env.GEMINI_API_KEY! }), {
          fallbacks: models.fallbacks,
        })
      : new MockAnalyzer();
  const channels =
    provider === "gemini"
      ? new CachedChannelLookup(
          new YouTubeDataApiChannelLookup({ apiKey: env.YOUTUBE_DATA_API_KEY! }),
          new MemoryKV(),
        )
      : new MockChannelLookup({ now: () => new Date(now()) });

  const info = {
    startedAt: new Date().toISOString(),
    provider,
    targetSize: set.target_size,
    versions: {
      pass1: PASS1_PROMPT_VERSION,
      features: FEATURES_VERSION,
      comparison: COMPARISON_VERSION,
      playbook: PLAYBOOK_VERSION,
      manifest: manifest.manifest_version,
    },
  };
  const results = await runPlaybookSet(set, {
    analyzer,
    channels,
    manifest,
    models,
    // Mock tokens priced at real rates would read as a real cost: price only real runs.
    pricing: provider === "gemini" ? pricing : undefined,
    now,
    log: (m) => console.log(`  ${m}`),
  });
  const summary = summarizePlaybooks(results);
  const outDir = `${ROOT}reports/${info.startedAt.replace(/[:.]/g, "-")}-playbooks-${provider}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    `${outDir}/report.json`,
    JSON.stringify({ info, summary, results }, null, 2) + "\n",
  );
  const report = playbookReport(info, summary, results);
  writeFileSync(`${outDir}/report.md`, report);
  if (flag("review")) writeFileSync(`${outDir}/review.md`, playbookReviewSheet(results));
  console.log(report.split("## Cases")[0]);
  console.log(`Report: ${outDir}/report.md`);
  // --gate: at least one case ran, and every case that ran passed.
  if (flag("gate") && (summary.ran === 0 || summary.passed < summary.ran)) {
    if (summary.ran === 0) console.error("Gate failed: no case ran.");
    process.exitCode = 1;
  }
}
