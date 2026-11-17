/**
 * Checks keys and model names using only free calls: Gemini model metadata and the
 * YouTube Data API (free quota). Optionally looks up videos: pnpm check:setup [link or ID ...]
 * --ping also sends each model one tiny paid request (a few tokens) to see if it is serving.
 */
import { classifyVideoState, formatTimecode, loadEnv, parseYouTubeSource } from "@match-cut/core";
import { YouTubeDataApiLookup } from "@match-cut/providers";
import { GoogleGenAI } from "@google/genai";

const env = loadEnv();
const rows: Record<string, unknown>[] = [];

if (env.GEMINI_API_KEY) {
  const ai = new GoogleGenAI({
    apiKey: env.GEMINI_API_KEY,
    httpOptions: { retryOptions: { attempts: 1 } },
  });
  const ping = process.argv.includes("--ping");
  const fallbacks = (env.GEMINI_MODEL_FALLBACK ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  for (const [role, model] of [
    ["standard", env.GEMINI_MODEL_STANDARD],
    ["deep", env.GEMINI_MODEL_DEEP],
    ...fallbacks.map((m, i) => [`fallback ${i + 1}`, m] as const),
  ] as const) {
    if (!model) {
      rows.push({ check: `gemini ${role}`, result: "not set" });
      continue;
    }
    try {
      const m = await ai.models.get({ model, config: { httpOptions: { timeout: 10000 } } });
      let pingResult = "";
      if (ping) {
        // One tiny paid call (a few tokens) to see whether the model is serving right now.
        try {
          const t = Date.now();
          await ai.models.generateContent({
            model,
            contents: "Reply with the single word OK.",
            config: { maxOutputTokens: 16, httpOptions: { timeout: 20000 } },
          });
          pingResult = ` | ping ok ${Date.now() - t}ms`;
        } catch (e) {
          pingResult = ` | ping FAILED ${(e as { status?: number }).status ?? (e as Error).message}`;
        }
      }
      rows.push({
        check: `gemini ${role}`,
        result: "ok",
        info: `${m.name} | in ${m.inputTokenLimit} / out ${m.outputTokenLimit} | thinking ${m.thinking ?? "?"}${pingResult}`,
      });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      rows.push({
        check: `gemini ${role}`,
        result: `FAILED ${err.status ?? ""}`,
        info: String(err.message).slice(0, 160),
      });
    }
  }
} else rows.push({ check: "gemini", result: "GEMINI_API_KEY not set" });

const sources = process.argv.slice(2).filter((a) => a !== "--" && !a.startsWith("--"));
if (env.YOUTUBE_DATA_API_KEY) {
  const lookup = new YouTubeDataApiLookup({ apiKey: env.YOUTUBE_DATA_API_KEY, timeoutMs: 10000 });
  for (const s of sources.length ? sources : ["dQw4w9WgXcQ"]) {
    const p = parseYouTubeSource(s);
    if (!p.ok) {
      rows.push({ check: `video ${s}`, result: p.code });
      continue;
    }
    const r = await lookup.lookup(p.videoId);
    if (r.status !== "found") {
      rows.push({
        check: `video ${p.videoId}`,
        result: r.status,
        info: "reason" in r ? r.reason : "",
      });
      continue;
    }
    const v = r.video;
    const state = classifyVideoState(v, env.YOUTUBE_REGION);
    rows.push({
      check: `video ${p.videoId}`,
      result: state.error ?? "ok",
      info: `${formatTimecode(v.durationSeconds)} | ${v.privacyStatus} | embed ${v.embeddable} | ${v.title.slice(0, 50)}`,
    });
  }
} else rows.push({ check: "youtube", result: "YOUTUBE_DATA_API_KEY not set" });

console.table(rows);
