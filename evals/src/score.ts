/** Deterministic scorers. PRD rubric rows scored by code: specificity, originality, adaptation checks. */
import {
  longestSharedRun,
  MAX_SHARED_RUN,
  type Breakdown,
  type CapabilityManifest,
} from "@match-cut/core";
import type { EvalCase, Reference } from "./types.js";

/** Every text field of the breakdown that holds observations. */
export function observationTexts(b: Breakdown): { field: string; text: string }[] {
  return [
    { field: "hook", text: b.hook },
    ...Object.entries(b.style).map(([k, v]) => ({ field: `style.${k}`, text: v })),
    ...b.beats.map((beat, i) => ({
      field: `beats[${i}]`,
      text: `${beat.label}: ${beat.what_happens}`,
    })),
  ];
}

const NUMERIC_DETAIL =
  /\b\d+(?:\.\d+)?\s*(?:%|percent\b|s\b|sec\b|secs\b|seconds?\b|bpm\b|wpm\b|words?\s+per\s+(?:line|minute|caption)|x\b|fps\b|frames?\b|shots?\b|cuts?\b|words?\b|steps?\b|lines?\b)|\b\d+\s*(?:to|-|–)\s*\d+\s*(?:%|percent|seconds?|s\b|words?)/gi;

/** PRD Specificity: numeric details per breakdown (at least 6). */
export function specificity(b: Breakdown): { count: number; examples: string[] } {
  const found = new Set<string>();
  for (const { text } of observationTexts(b)) {
    for (const m of text.matchAll(NUMERIC_DETAIL))
      found.add(m[0].toLowerCase().replace(/\s+/g, " "));
  }
  // The structured average shot length is a numeric detail too.
  if (b.format.avg_shot_length_seconds) found.add(`avg shot ${b.format.avg_shot_length_seconds}s`);
  return { count: found.size, examples: [...found].slice(0, 10) };
}

/** PRD Originality: no copied script (more than 12 consecutive words) and no brand terms. */
export function originality(
  promptAndLists: string,
  spokenLines: string[],
  reference: Reference | null,
): { pass: boolean; sharedRun: number; brandHits: string[] } {
  const sharedRun = longestSharedRun(promptAndLists, spokenLines);
  const lower = promptAndLists.toLowerCase();
  const brandHits = (reference?.brand_terms ?? []).filter(
    (t) => t.trim().length >= 3 && lower.includes(t.trim().toLowerCase()),
  );
  return { pass: sharedRun <= MAX_SHARED_RUN && brandHits.length === 0, sharedRun, brandHits };
}

const STOP = new Set(
  "about after again along also another because before being below between could every first from have here into just like made make making more most much must only other over same should some such than that their them then there these they thing this those through under until very what when where which while with would your video short clip second seconds minute".split(
    " ",
  ),
);

/** Code checks behind PRD Adaptation; the judge rates the rest. */
export function adaptationChecks(
  prompt: string,
  c: EvalCase,
  b: Breakdown,
): { pass: boolean; failed: string[] } {
  const p = prompt.toLowerCase();
  const failed: string[] = [];
  const goalWords = c.goal
    .toLowerCase()
    .split(/[^\p{L}\p{M}]+/u)
    .filter((w) => w.length >= 5 && !STOP.has(w));
  if (goalWords.length && !goalWords.some((w) => p.includes(w)))
    failed.push("the prompt doesn't reflect the goal");
  const target = c.target.format;
  if (
    target !== "match" &&
    target !== b.format.aspect_ratio &&
    !/(refram|crop|vertical|horizontal|square|portrait|9:16|16:9|1:1|4:5)/.test(p)
  ) {
    failed.push(`no reframing step for ${b.format.aspect_ratio} -> ${target}`);
  }
  const ref = /^(\d+):(\d{2})$/.exec(b.format.duration);
  const refSeconds = ref ? Number(ref[1]) * 60 + Number(ref[2]) : null;
  if (c.target.length_seconds && refSeconds && c.target.length_seconds < refSeconds * 0.9) {
    if (
      !/(keep|merge|drop|condens|cut down|trim|shorten|target \d|\d+:\d{2}|\d+\s*seconds?)/.test(p)
    ) {
      failed.push("no condensing step for a shorter target");
    }
  }
  return { pass: failed.length === 0, failed };
}

/** Numbered steps in a prompt. */
export function promptSteps(prompt: string): { step: number; text: string }[] {
  return prompt
    .split("\n")
    .map((l) => /^(\d{1,2})[.)]\s+(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ step: Number(m[1]), text: m[2]! }));
}

const OP_HINTS: Record<string, RegExp> = {
  cut: /\b(cut|rough cut|order|open on|structure)\b/i,
  trim: /\btrim\b/i,
  reorder: /\b(reorder|order the|rearrange)\b/i,
  remove_silences: /\b(silence|pauses?|dead air)\b/i,
  captions: /\bcaptions?\b/i,
  titles: /\b(titles?|title card|text overlay|overlay|lower third)\b/i,
  transitions: /\b(transitions?|whip|crossfade|fade)\b/i,
  zoom_and_reframe: /\b(zoom|punch-?in|refram|crop|frame)\b/i,
  lut: /\b(grade|lut|color|colour)\b/i,
  music_generation: /\bmusic\b/i,
  sound_effects: /\b(sound effects?|whoosh|pop|sfx)\b/i,
  voiceover: /\bvoice-?over\b/i,
  generated_broll: /\bb-?roll\b/i,
};

/** Keyword mapping of prompt steps to manifest operations (mock judge and a cross-check). */
export function mapStepsToOperations(prompt: string, manifest: CapabilityManifest) {
  const ids = new Set(manifest.operations.map((o) => o.id));
  return promptSteps(prompt).map((s) => {
    const op =
      Object.entries(OP_HINTS).find(([id, re]) => ids.has(id) && re.test(s.text))?.[0] ?? null;
    return { ...s, operation: op };
  });
}
