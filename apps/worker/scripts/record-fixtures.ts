/**
 * Records real pass 1 responses as fixtures. Calls the paid Gemini API: one watch call per video,
 * plus one repair call if needed.
 *
 *   pnpm record:fixtures --yes <youtube link or ID> [...] [--detail deep] [--clip 0-120] [--model ID]
 *
 * --model records with that exact model and no fallback chain (e.g. interim fixtures on a
 * cheaper model while the standard one is unavailable).
 *
 * Writes, per video:
 *   packages/providers/fixtures/pass1/<id>.json        validated pass 1 output (used by MockAnalyzer)
 *   packages/providers/fixtures/recordings/<id>.json   raw response, problems, repair, usage, timings
 */
import {
  canonicalYouTubeUrl,
  classifyVideoState,
  loadEnv,
  modelNames,
  parseYouTubeSource,
  resolveClipRange,
  type AnalyzedRange,
  type Detail,
} from "@match-cut/core";
import { GeminiAnalyzer, withFallback, YouTubeDataApiLookup } from "@match-cut/providers";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { watchAndValidate } from "../src/pass1.js";

const FIXTURES = fileURLToPath(new URL("../../../packages/providers/fixtures/", import.meta.url));

const args = process.argv.slice(2).filter((a) => a !== "--");
const yes = args.includes("--yes");
const detail: Detail =
  args.includes("--detail") && args[args.indexOf("--detail") + 1] === "deep" ? "deep" : "standard";
const clipArg = args.includes("--clip") ? args[args.indexOf("--clip") + 1] : undefined;
const modelArg = args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined;
const sources = args.filter(
  (a, i) => !a.startsWith("--") && !["--detail", "--clip", "--model"].includes(args[i - 1] ?? ""),
);

if (!yes || sources.length === 0) {
  console.error(
    "Usage: pnpm record:fixtures --yes <link or ID> [...] [--detail deep] [--clip START-END]",
  );
  console.error("This calls the paid Gemini API once or twice per video. --yes is required.");
  process.exit(1);
}

const env = loadEnv();
if (!env.GEMINI_API_KEY || !env.GEMINI_MODEL_STANDARD || !env.GEMINI_MODEL_DEEP) {
  console.error("Set GEMINI_API_KEY, GEMINI_MODEL_STANDARD and GEMINI_MODEL_DEEP in .env first.");
  process.exit(1);
}
const models = modelNames({ ...env, PROVIDER: "gemini" } as typeof env);
const analyzer = withFallback(new GeminiAnalyzer({ apiKey: env.GEMINI_API_KEY }), {
  fallbacks: modelArg ? [] : models.fallbacks,
  onAttempt: ({ model, attempt, error }) =>
    console.error(
      `  ${model} attempt ${attempt}: ${error ? `${error.error.code} ${JSON.stringify(error.detail?.status ?? "")}` : "ok"}`,
    ),
});
const lookup = env.YOUTUBE_DATA_API_KEY
  ? new YouTubeDataApiLookup({ apiKey: env.YOUTUBE_DATA_API_KEY })
  : null;

mkdirSync(`${FIXTURES}pass1`, { recursive: true });
mkdirSync(`${FIXTURES}recordings`, { recursive: true });

const rows: Record<string, unknown>[] = [];
for (const source of sources) {
  const parsed = parseYouTubeSource(source);
  if (!parsed.ok) {
    rows.push({ source, result: parsed.code });
    continue;
  }
  const id = parsed.videoId;
  let duration: number | null = null;
  let title = "";
  if (lookup) {
    const found = await lookup.lookup(id);
    if (found.status === "not_found") {
      rows.push({ id, result: "VIDEO_NOT_FOUND" });
      continue;
    }
    if (found.status === "found") {
      const state = classifyVideoState(found.video, env.YOUTUBE_REGION);
      if (state.error) {
        rows.push({ id, result: state.error });
        continue;
      }
      duration = found.video.durationSeconds;
      title = found.video.title;
    }
  }
  let range: AnalyzedRange | null = null;
  if (clipArg) {
    const [s, e] = clipArg.split("-").map(Number);
    const c = resolveClipRange({ start_seconds: s, end_seconds: e }, duration ?? undefined);
    if (!c.ok) {
      rows.push({ id, result: c.code });
      continue;
    }
    range = c.range;
  } else if (duration !== null && duration > env.MAX_VIDEO_SECONDS) {
    rows.push({ id, result: "VIDEO_TOO_LONG (pass --clip)" });
    continue;
  }
  const analyzed = range ? range.end_seconds - range.start_seconds : duration;
  const model = modelArg ?? (detail === "deep" ? models.deep : models.standard);
  const started = Date.now();
  try {
    const run = await watchAndValidate(
      analyzer,
      {
        videoId: id,
        canonicalUrl: canonicalYouTubeUrl(id),
        range,
        detail,
        model,
        durationSeconds: duration,
      },
      analyzed,
    );
    const seconds = (Date.now() - started) / 1000;
    writeFileSync(`${FIXTURES}pass1/${id}.json`, JSON.stringify(run.output, null, 2) + "\n");
    writeFileSync(
      `${FIXTURES}recordings/${id}.json`,
      JSON.stringify(
        {
          id,
          title,
          duration,
          range,
          detail,
          model: run.model,
          seconds,
          tokens: run.tokens,
          repairUsed: run.repairUsed,
          problems: run.problems,
          recordedAt: new Date().toISOString(),
          raw: run.raw,
        },
        null,
        2,
      ) + "\n",
    );
    rows.push({
      id,
      model: run.model,
      type: run.output.video_type,
      beats: run.output.beats.length,
      repair: run.repairUsed,
      seconds: Math.round(seconds),
      tokensIn: run.tokens.input,
      tokensOut: run.tokens.output,
    });
  } catch (e) {
    const err = e as { error?: { code: string }; detail?: unknown; message?: string };
    rows.push({
      id,
      result: err.error?.code ?? "ERROR",
      detail: JSON.stringify(err.detail ?? err.message),
    });
  }
}
console.table(rows);
