/**
 * Pass 2 post-processing. PRD: "Post-processing and validation" (prompt word count, no URLs or
 * markdown), "Input safety" (reject prompts with instructions to ignore rules) and
 * "Copyright and platform terms" (no run of more than 12 words matching the spoken lines).
 * Shot list checks: PRD-playbooks.md, Feature 2 (4 to 15 shots, valid beats, total within 25%
 * of the target length).
 */
import { z } from "zod";
import {
  pass2CoreSchema,
  SHOT_LIST_MAX,
  SHOT_LIST_MIN,
  shotSchema,
  type Pass2Output,
  type Shot,
} from "./schemas.js";

export const PROMPT_MIN_WORDS = 150;
export const PROMPT_MAX_WORDS = 350;
/** PRD: flag any run of MORE than 12 words matching a spoken line. */
export const MAX_SHARED_RUN = 12;

// Languages written without spaces: count characters instead of words.
const UNSPACED = /^(zh|ja|th|lo|km|my)(-|$)/i;

export function countWords(text: string, language = "en"): number {
  if (UNSPACED.test(language)) return Math.round(text.replace(/\s/g, "").length / 2);
  return text.split(/\s+/).filter(Boolean).length;
}

/** Strips markdown but keeps "1. " numbered steps and line breaks. */
export function stripPromptMarkdown(text: string): string {
  return text
    .replace(/```\w*\n?/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|\s)\*(\S(?:.*?\S)?)\*(?=\s|[.,;:!?]|$)/gm, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+•]\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

/**
 * Puts inline numbered steps ("1. Cut... 2. Trim...") on their own lines. Formatting only:
 * applied when the text has fewer than 3 step lines but at least 3 inline step markers.
 */
export function splitInlineSteps(text: string): string {
  const stepLines = text.split("\n").filter((l) => /^\s*\d{1,2}[.)]\s/.test(l)).length;
  const inline = text.match(/(?:^|\s)\d{1,2}\.\s+(?=\S)/g) ?? [];
  if (stepLines >= 3 || inline.length < 3) return text;
  return text.replace(/\s+(?=\d{1,2}\.\s+[A-Z\p{Lu}])/gu, "\n");
}

export function normalizePass2(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = { ...(raw as Record<string, unknown>) };
  if (typeof o.cardboard_prompt === "string")
    o.cardboard_prompt = splitInlineSteps(stripPromptMarkdown(o.cardboard_prompt));
  for (const k of ["assets_needed", "watch_outs"]) {
    if (Array.isArray(o[k])) {
      o[k] = (o[k] as unknown[])
        .map((v) => (typeof v === "string" ? stripPromptMarkdown(v) : v))
        .filter((v) => v !== "");
    }
  }
  if (Array.isArray(o.shot_list)) {
    o.shot_list = (o.shot_list as unknown[]).map((item) => {
      if (!item || typeof item !== "object") return item;
      const shot = { ...(item as Record<string, unknown>) };
      for (const k of ["shot", "framing", "notes"]) {
        if (typeof shot[k] === "string") shot[k] = stripPromptMarkdown(shot[k] as string);
      }
      return shot;
    });
  }
  return o;
}

/** Shot durations may add up to this far from the target length (PRD: within 25%). */
export const SHOT_TOTAL_TOLERANCE = 0.25;

const tokens = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Longest run of consecutive words shared by `text` and any of `lines`. */
export function longestSharedRun(text: string, lines: string[]): number {
  const t = tokens(text);
  let best = 0;
  for (const line of lines) {
    const l = tokens(line);
    // Classic longest-common-substring over word arrays; inputs are small.
    let prev = new Array<number>(l.length + 1).fill(0);
    for (let i = 1; i <= t.length; i++) {
      const cur = new Array<number>(l.length + 1).fill(0);
      for (let j = 1; j <= l.length; j++) {
        if (t[i - 1] === l[j - 1]) {
          cur[j] = prev[j - 1]! + 1;
          if (cur[j]! > best) best = cur[j]!;
        }
      }
      prev = cur;
    }
  }
  return best;
}

/** Text checks shared with playbook writing. */
export const URL_IN_TEXT =
  /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|ai|app|dev|ly|be|tv)\b/i;
export const INJECTION =
  /\b(ignore|disregard|override)\b[^.\n]{0,40}\b(instructions|rules|system prompt|previous)\b|\bsystem prompt\b/i;
export const MARKDOWN_LEFT = /(\*\*|__|^#{1,6}\s|```|\[[^\]]+\]\([^)]+\))/m;

export interface Pass2Check {
  /** True when both the prompt and the shot list pass. */
  ok: boolean;
  /**
   * The output whenever the prompt itself is valid. Its shot_list is empty when the shot list
   * failed, so callers can still save the prompt.
   */
  output: Pass2Output | null;
  /** Every problem, prompt and shot list, for the repair call. */
  problems: string[];
  /** The shot-list subset of `problems`. Only these left: the prompt is fine. */
  shotListProblems: string[];
}

export interface Pass2CheckOptions {
  spokenLines: string[];
  language: string;
  /** Beats in the breakdown, for maps_to_beat. Omit to skip that check. */
  beatCount?: number;
  /** Target length in seconds, for the shot-list total. Null or omitted: no total check. */
  targetSeconds?: number | null;
}

const issues = (e: z.ZodError, prefix = "") =>
  e.issues.map((i) => `${prefix}${i.path.join(".") || "root"}: ${i.message}`);

function checkShotList(
  raw: unknown,
  opts: Pass2CheckOptions,
): { shots: Shot[]; problems: string[] } {
  const parsed = z.array(shotSchema).safeParse(raw ?? []);
  if (!parsed.success) return { shots: [], problems: issues(parsed.error, "shot_list.") };
  const shots = parsed.data;
  const problems: string[] = [];
  if (shots.length < SHOT_LIST_MIN || shots.length > SHOT_LIST_MAX) {
    problems.push(
      `shot_list has ${shots.length} shots; it needs ${SHOT_LIST_MIN} to ${SHOT_LIST_MAX}`,
    );
  }
  if (opts.beatCount !== undefined) {
    shots.forEach((s, i) => {
      if (s.maps_to_beat > opts.beatCount!) {
        problems.push(
          `shot_list[${i}].maps_to_beat is ${s.maps_to_beat}; the reference has ${opts.beatCount} beats`,
        );
      }
    });
  }
  if (opts.targetSeconds && shots.length) {
    const total = Math.round(shots.reduce((sum, s) => sum + s.duration_seconds, 0));
    const target = opts.targetSeconds;
    if (Math.abs(total - target) > target * SHOT_TOTAL_TOLERANCE) {
      problems.push(
        `shot_list durations add up to ${total} seconds; they should be close to ${target}`,
      );
    }
  }
  shots.forEach((s, i) => {
    for (const [field, text] of [
      ["shot", s.shot],
      ["framing", s.framing],
      ["notes", s.notes],
    ] as const) {
      if (URL_IN_TEXT.test(text))
        problems.push(`shot_list[${i}].${field} contains a URL or web address; remove it`);
      if (MARKDOWN_LEFT.test(text))
        problems.push(`shot_list[${i}].${field} contains markdown; use plain text`);
      if (INJECTION.test(text))
        problems.push(`shot_list[${i}].${field} contains instructions; describe the shot only`);
    }
  });
  const run = longestSharedRun(
    shots.map((s) => `${s.shot}\n${s.notes}`).join("\n"),
    opts.spokenLines,
  );
  if (run > MAX_SHARED_RUN) {
    problems.push(
      `shot_list repeats ${run} consecutive words from the reference's speech; write original wording`,
    );
  }
  return { shots, problems };
}

export function checkPass2(normalized: unknown, opts: Pass2CheckOptions): Pass2Check {
  const rawShots =
    normalized && typeof normalized === "object"
      ? (normalized as Record<string, unknown>).shot_list
      : undefined;
  const core = (() => {
    if (!normalized || typeof normalized !== "object") return normalized;
    const { shot_list: _ignored, ...rest } = normalized as Record<string, unknown>;
    return rest;
  })();
  const parsed = pass2CoreSchema.safeParse(core);
  const shotCheck = checkShotList(rawShots, opts);
  if (!parsed.success) {
    const problems = [...issues(parsed.error), ...shotCheck.problems];
    return { ok: false, output: null, problems, shotListProblems: shotCheck.problems };
  }
  const out = parsed.data;
  const problems: string[] = [];
  const prompt = out.cardboard_prompt;
  const words = countWords(prompt, opts.language);
  if (words < PROMPT_MIN_WORDS)
    problems.push(`cardboard_prompt has ${words} words; it needs at least ${PROMPT_MIN_WORDS}`);
  if (words > PROMPT_MAX_WORDS)
    problems.push(`cardboard_prompt has ${words} words; it must be at most ${PROMPT_MAX_WORDS}`);
  const steps = prompt.split("\n").filter((l) => /^\d{1,2}[.)]\s/.test(l)).length;
  if (steps < 3)
    problems.push(
      'cardboard_prompt must be numbered steps, each on its own line starting with "1. ", "2. " and so on',
    );
  for (const [field, text] of [
    ["cardboard_prompt", prompt],
    ...out.assets_needed.map((a, i) => [`assets_needed[${i}]`, a] as const),
    ...out.watch_outs.map((w, i) => [`watch_outs[${i}]`, w] as const),
  ] as const) {
    if (URL_IN_TEXT.test(text)) problems.push(`${field} contains a URL or web address; remove it`);
    if (MARKDOWN_LEFT.test(text)) problems.push(`${field} contains markdown; use plain text`);
    if (INJECTION.test(text))
      problems.push(
        `${field} contains instructions about rules or prompts; describe the edit only`,
      );
  }
  if (out.watch_outs.length === 0) problems.push("watch_outs needs at least one item");
  const run = longestSharedRun(
    [prompt, ...out.assets_needed, ...out.watch_outs].join("\n"),
    opts.spokenLines,
  );
  if (run > MAX_SHARED_RUN) {
    problems.push(
      `the output repeats ${run} consecutive words from the reference's speech; write original wording`,
    );
  }
  const shotsOk = shotCheck.problems.length === 0;
  return {
    ok: problems.length === 0 && shotsOk,
    output: problems.length === 0 ? { ...out, shot_list: shotsOk ? shotCheck.shots : [] } : null,
    problems: [...problems, ...shotCheck.problems],
    shotListProblems: shotCheck.problems,
  };
}
