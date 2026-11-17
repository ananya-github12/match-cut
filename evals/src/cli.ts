/**
 * Eval runner.
 *
 *   pnpm eval                       smoke set, mock provider, mock judge (free, offline)
 *   pnpm eval --set golden --provider gemini --judge gemini --yes
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
if (
  !["smoke", "golden"].includes(setName) ||
  !["mock", "gemini"].includes(provider) ||
  !["mock", "gemini"].includes(judgeName)
) {
  console.error(
    "Usage: pnpm eval [--set smoke|golden] [--provider mock|gemini] [--judge mock|gemini] [--only id] [--gate] [--update-baseline] [--review] [--yes]",
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
