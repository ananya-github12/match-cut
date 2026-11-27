/**
 * Fallback wording for playbook rules: used when the model leaves a computed rule unwritten
 * (after its one repair), so a playbook never fails over missing words. Drafted in M10; listed
 * in PRD-playbooks.md for sign-off. Plain text, imperative titles under 8 words.
 */
import type { FeatureName } from "./features.js";

export interface RuleCopy {
  title: string;
  how_to: string;
}

export const FEATURE_COPY: Partial<Record<FeatureName, Record<string, RuleCopy>>> = {
  hook_type: {
    question: {
      title: "Open on a spoken question",
      how_to:
        "Make the first line a question to the viewer, inside the first second, before any title card.",
    },
    bold_claim: {
      title: "Lead with a bold claim",
      how_to: "Open with your strongest statement or promise in the first second, then back it up.",
    },
    result_first: {
      title: "Show the result first",
      how_to: "Open on the finished result, then cut back to show how you got there.",
    },
    visual_surprise: {
      title: "Open on a visual surprise",
      how_to: "Start on an unexpected image or motion in the first second, before any talking.",
    },
    story_open: {
      title: "Start in the middle of a story",
      how_to: "Drop the viewer into a scene already in progress; explain the setup later.",
    },
  },
  first_words_timing: {
    under_1s: {
      title: "Speak within the first second",
      how_to: "Cut any lead-in so your first word lands in the first second.",
    },
    "1_to_3s": {
      title: "Start talking within 3 seconds",
      how_to: "Give the opening shot a beat, then start speaking before the 3-second mark.",
    },
    over_3s: {
      title: "Let the visuals breathe first",
      how_to: "Hold on visuals or music for a few seconds before the first spoken line.",
    },
    no_speech: {
      title: "Tell it without talking",
      how_to: "Carry the video with visuals, text and music; leave out voice.",
    },
  },
  text_on_screen_first_second: {
    yes: {
      title: "Put text on screen immediately",
      how_to: "Show a short title or caption in the first second that tells viewers what's coming.",
    },
    no: {
      title: "Keep the first second text-free",
      how_to: "Let the opening shot play clean; add titles only after the hook lands.",
    },
  },
  face_in_first_shot: {
    yes: {
      title: "Show a face in the first shot",
      how_to: "Open on a close-up of a person looking at the camera.",
    },
    no: {
      title: "Open on something other than a face",
      how_to: "Start on the product, place or action, and bring people in later.",
    },
  },
  caption_style: {
    word_by_word: {
      title: "Use word-by-word captions",
      how_to: "Caption 1 to 3 words at a time, synced to speech, with the active word highlighted.",
    },
    phrase: {
      title: "Caption in full phrases",
      how_to: "Show captions a phrase or sentence at a time, in a steady position.",
    },
    none: {
      title: "Skip the captions",
      how_to: "Leave speech uncaptioned and let the visuals and voice carry it.",
    },
  },
  zoom_punch_ins: {
    frequent: {
      title: "Punch in on most cuts",
      how_to: "Add a 110 to 120 percent zoom on most cuts to keep the energy up.",
    },
    some: {
      title: "Punch in now and then",
      how_to: "Add a quick zoom on key lines only, every few cuts.",
    },
    none: {
      title: "Keep the frame steady",
      how_to: "Avoid zooms; let cuts and framing do the work.",
    },
  },
  music: {
    trending_or_upbeat: {
      title: "Use an upbeat track",
      how_to: "Put an energetic track under the whole video, low enough that speech stays clear.",
    },
    ambient: {
      title: "Keep music as a quiet bed",
      how_to: "Use soft background music that never competes with the voice.",
    },
    none: {
      title: "Go without music",
      how_to: "Leave out music and let voice and natural sound carry the video.",
    },
  },
  ending: {
    call_to_action: {
      title: "End on a clear call to action",
      how_to: "Finish with one direct ask, such as follow or try it, and cut right after it.",
    },
    loop: {
      title: "Make the ending loop back",
      how_to: "End on a shot or line that flows straight back into the opening.",
    },
    cliffhanger: {
      title: "End on a cliffhanger",
      how_to: "Stop just before the payoff so viewers want the next video.",
    },
    abrupt: {
      title: "Cut off sharply at the end",
      how_to: "End mid-moment with a hard cut, with no outro.",
    },
  },
  avg_shot_length_bucket: {
    under_1s: {
      title: "Cut faster than once a second",
      how_to: "Keep most shots under 1 second, cutting on every phrase or beat.",
    },
    "1_to_2s": {
      title: "Cut every 1 to 2 seconds",
      how_to: "Keep shots between 1 and 2 seconds, and remove pauses.",
    },
    "2_to_4s": {
      title: "Hold shots for 2 to 4 seconds",
      how_to: "Let each shot run 2 to 4 seconds; cut on the end of each idea.",
    },
    over_4s: {
      title: "Let shots run longer",
      how_to: "Hold shots for more than 4 seconds and let moments play out.",
    },
  },
  length_bucket: {
    under_15s: {
      title: "Keep it under 15 seconds",
      how_to: "Trim to one idea and finish before 15 seconds.",
    },
    "15_to_30s": {
      title: "Aim for 15 to 30 seconds",
      how_to: "Cover one idea with a hook, a middle and a payoff in 15 to 30 seconds.",
    },
    "30_to_60s": {
      title: "Aim for 30 to 60 seconds",
      how_to: "Use the extra time for a few quick steps or examples, keeping the pace up.",
    },
    over_60s: {
      title: "Go past a minute",
      how_to: "Build a fuller story over more than a minute, with a new beat every few seconds.",
    },
  },
};

/** Wording for a computed rule: the table's, or a neutral line if a value isn't listed. */
export function fallbackCopy(feature: FeatureName, value: string): RuleCopy {
  return (
    FEATURE_COPY[feature]?.[value] ?? {
      title: "Repeat this choice",
      how_to: `Match the breakouts' ${feature.replace(/_/g, " ")}: ${value.replace(/_/g, " ")}.`,
    }
  );
}

/**
 * Lines code writes when the model's wording is missing or fails the checks. Drafted in M10;
 * listed in PRD-playbooks.md for sign-off.
 */
export const PLAYBOOK_COPY = {
  /** {items}: fallback titles of the house-style values, lower-cased, joined with "; ". */
  HOUSE_STYLE:
    "Nearly every compared video does this, breakouts or not, so it isn't what sets the breakouts apart: {items}.",
  /** {topics}: up to 3 shared title words. */
  TOPIC_NOT_EXPLAINED:
    "Most breakouts share a topic ({topics}), so the topic may matter as much as the edit.",
  DEFAULT_NOT_EXPLAINED:
    "Timing, trends and the channel's audience also shape how a video does, beyond the edit.",
} as const;

export function fillCopy(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}
