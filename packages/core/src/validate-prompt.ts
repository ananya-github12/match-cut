/**
 * Pass 2 post-processing. PRD: "Post-processing and validation" (prompt word count, no URLs or
 * markdown), "Input safety" (reject prompts with instructions to ignore rules) and
 * "Copyright and platform terms" (no run of more than 12 words matching the spoken lines).
 */
import { pass2OutputSchema, type Pass2Output } from "./schemas.js";

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
  return o;
}

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

const URL_IN_TEXT =
  /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|ai|app|dev|ly|be|tv)\b/i;
const INJECTION =
  /\b(ignore|disregard|override)\b[^.\n]{0,40}\b(instructions|rules|system prompt|previous)\b|\bsystem prompt\b/i;
const MARKDOWN_LEFT = /(\*\*|__|^#{1,6}\s|```|\[[^\]]+\]\([^)]+\))/m;

export interface Pass2Check {
  ok: boolean;
  output: Pass2Output | null;
  problems: string[];
}

export function checkPass2(
  normalized: unknown,
  opts: { spokenLines: string[]; language: string },
): Pass2Check {
  const parsed = pass2OutputSchema.safeParse(normalized);
  if (!parsed.success) {
    return {
      ok: false,
      output: null,
      problems: parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`),
    };
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
  return { ok: problems.length === 0, output: out, problems };
}
