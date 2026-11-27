/**
 * Building a skill from a brief or a playbook (PRD-playbooks.md, Feature 4): a snapshot of what
 * apply needs, plus the versions it was made with, so the skill outlives its source and caches.
 */
import {
  COMPARISON_VERSION,
  FEATURES_VERSION,
  PASS1_PROMPT_VERSION,
  PASS2_PROMPT_VERSION,
  PLAYBOOK_VERSION,
  SCHEMA_VERSION,
} from "@match-cut/core";
import type { BriefRecord, PlaybookRecord, SkillSnapshot } from "./types.js";

export interface SkillDraft {
  snapshot: SkillSnapshot;
  sourceTitle: string | null;
  versions: Record<string, string>;
}

/** Why a source can't become a skill yet. */
export type SkillDraftProblem = "NOT_READY" | "NO_RULES";

/** A brief's breakdown, once pass 1 has finished (a partial brief has one too). */
export function skillFromBrief(b: BriefRecord): SkillDraft | SkillDraftProblem {
  if ((b.status !== "succeeded" && b.status !== "partial") || !b.breakdown) return "NOT_READY";
  return {
    snapshot: {
      type: "brief",
      videoId: b.videoId,
      videoTitle: b.video?.title ?? null,
      breakdown: b.breakdown,
      spokenLines: b.spokenLines ?? [],
    },
    sourceTitle: b.video?.title ?? null,
    versions: {
      pass1: PASS1_PROMPT_VERSION,
      pass2: PASS2_PROMPT_VERSION,
      schema: SCHEMA_VERSION,
    },
  };
}

/** A finished playbook's rules and recipe. A playbook with no rules has nothing to reuse. */
export function skillFromPlaybook(p: PlaybookRecord): SkillDraft | SkillDraftProblem {
  if (p.status !== "succeeded" || !p.content || !p.channel) return "NOT_READY";
  if (p.content.rules.length === 0) return "NO_RULES";
  return {
    snapshot: {
      type: "playbook",
      channel: { id: p.channel.id, title: p.channel.title, handle: p.channel.handle },
      rules: p.content.rules,
      houseStyle: p.content.house_style,
      notExplained: p.content.not_explained,
      recipePromptTemplate: p.content.recipe_prompt_template,
      spokenLines: p.spokenLines ?? [],
    },
    sourceTitle: p.channel.title,
    versions: {
      ...p.meta.versions,
      // What this code would write today, in case the stored meta predates a field.
      features: p.meta.versions.features ?? FEATURES_VERSION,
      comparison: p.meta.versions.comparison ?? COMPARISON_VERSION,
      playbook: p.meta.versions.playbook ?? PLAYBOOK_VERSION,
    },
  };
}
