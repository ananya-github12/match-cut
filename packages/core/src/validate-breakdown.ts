/**
 * Pass 1 post-processing. PRD: "Backend: Gemini integration > Post-processing and validation".
 * normalize -> schema check -> semantic checks; the caller makes one repair call on failure.
 */
import { pass1OutputSchema, type Pass1Output } from "./schemas.js";
import { formatMmSs } from "./timecode.js";
import type { WarningCode } from "./errors.js";

/** "7", "0:07", "00:07", "1:02:03", "01:02.5" -> seconds. Null if unreadable. */
export function parseLooseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.floor(Number(s));
  const m = /^(?:(\d+):)?(\d{1,3}):(\d{1,2})(?:\.\d+)?$/.exec(s);
  if (!m) return null;
  const [, h, min, sec] = m;
  if (Number(sec) > 59) return null;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec);
}

/** Strips markdown left in prose fields: bold, italics, code ticks, heading and bullet markers. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, ""))
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|[.,;:!?]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function normalizeStrings(value: unknown): unknown {
  if (typeof value === "string") return stripMarkdown(value);
  if (Array.isArray(value)) return value.map(normalizeStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeStrings(v)]));
  }
  return value;
}

/**
 * Trims whitespace, strips markdown and rewrites timestamps as mm:ss, leaving anything it can't
 * read untouched so the checks report it.
 */
export function normalizePass1(raw: unknown): unknown {
  const out = normalizeStrings(raw) as Record<string, unknown>;
  if (!out || typeof out !== "object") return out;
  const fmt = (v: unknown) => {
    const s = parseLooseTimestamp(v);
    return s === null ? v : formatMmSs(s);
  };
  const format = out.format as Record<string, unknown> | undefined;
  if (format && typeof format === "object") format.duration = fmt(format.duration);
  if (Array.isArray(out.beats)) {
    out.beats = out.beats.map((b) =>
      b && typeof b === "object" ? { ...b, start: fmt(b.start), end: fmt(b.end) } : b,
    );
  }
  return out;
}

export interface Pass1Check {
  ok: boolean;
  output: Pass1Output | null;
  /** Plain-English problems, sent to the model in the repair call. */
  problems: string[];
}

const TOLERANCE_SECONDS = 1;

/**
 * Schema + semantic checks. `analyzedSeconds` is the section length (null if unknown because the
 * precheck was skipped; the duration checks are skipped then).
 */
export function checkPass1(normalized: unknown, analyzedSeconds: number | null): Pass1Check {
  const parsed = pass1OutputSchema.safeParse(normalized);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`);
    return { ok: false, output: null, problems };
  }
  const out = parsed.data;
  const problems: string[] = [];
  const limit = analyzedSeconds === null ? null : analyzedSeconds + TOLERANCE_SECONDS;
  const beats = out.beats.map((b) => ({
    ...b,
    s: parseLooseTimestamp(b.start)!,
    e: parseLooseTimestamp(b.end)!,
  }));

  beats.forEach((b, i) => {
    if (b.e <= b.s) problems.push(`beats[${i}]: end ${b.end} must be after start ${b.start}`);
    if (limit !== null && b.e > limit) {
      problems.push(
        `beats[${i}]: end ${b.end} is past the end of the analyzed section (${formatMmSs(analyzedSeconds!)})`,
      );
    }
    const prev = beats[i - 1];
    if (prev && b.s < prev.s)
      problems.push(`beats[${i}]: starts before beats[${i - 1}]; beats must be in order`);
    else if (prev && b.s < prev.e) {
      problems.push(
        `beats[${i}]: starts at ${b.start}, overlapping beats[${i - 1}] which ends at ${prev.end}`,
      );
    }
    const words = b.label.trim().split(/\s+/).length;
    if (words > 4) problems.push(`beats[${i}].label: "${b.label}" must be 2 to 4 words`);
  });

  const total = analyzedSeconds ?? Math.max(...beats.map((b) => b.e));
  if (beats.length > 2 && total > 0) {
    beats.forEach((b, i) => {
      if (b.e - b.s > 0.6 * total) {
        problems.push(
          `beats[${i}]: lasts ${b.e - b.s}s, more than 60% of the ${total}s video; split it`,
        );
      }
    });
  }

  const dur = parseLooseTimestamp(out.format.duration)!;
  if (limit !== null && dur > limit + 2) {
    problems.push(
      `format.duration ${out.format.duration} is longer than the analyzed section (${formatMmSs(analyzedSeconds!)})`,
    );
  }
  if (out.spoken_lines_internal.length > 0 && !out.signals.has_speech) {
    problems.push("spoken_lines_internal has lines but signals.has_speech is false");
  }

  return { ok: problems.length === 0, output: out, problems };
}

/** Warning codes derived from the breakdown. PRD post-processing step 5. */
export function breakdownWarnings(out: Pass1Output): WarningCode[] {
  const w: WarningCode[] = [];
  // No signal for "static picture" in the PRD schema: very long average shots stand in for it.
  if (out.format.avg_shot_length_seconds >= LOW_VISUAL_SHOT_SECONDS) w.push("LOW_VISUAL_SIGNAL");
  if (!out.signals.has_speech) w.push("NO_SPEECH");
  return w;
}

export const LOW_VISUAL_SHOT_SECONDS = 20;
