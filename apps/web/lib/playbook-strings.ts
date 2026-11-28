/**
 * Copy for the playbook page and skills list (PRD-playbooks.md, Frontend additions). Drafted in
 * M10.9 and listed in the PRD for sign-off. Error and warning messages come from
 * @match-cut/core/errors, never from server text.
 */
export const P = {
  pageTitle: "Channel playbook",
  intro:
    "See what a channel's breakout Shorts do differently from its typical ones, then use it for your own video.",
  channelLabel: "Channel",
  channelPlaceholder: "@handle, a channel link, or one of its video links",
  windowLabel: "Look back",
  windowOptions: [
    { value: 30, label: "30 days" },
    { value: 60, label: "60 days" },
    { value: 90, label: "90 days" },
    { value: 180, label: "180 days" },
  ],
  start: "Build playbook",
  publicOnly: "Uses public data only.",

  stages: {
    queued: "Waiting to start",
    resolving_channel: "Finding the channel",
    fetching_stats: "Getting recent Shorts",
    scoring: "Finding the breakouts",
    watching: "Watching the Shorts",
    extracting: "Reading how each is edited",
    comparing: "Comparing breakouts with typical Shorts",
    writing_playbook: "Writing the playbook",
    validating: "Checking every number",
  } as Record<string, string>,
  watching: (done: number, total: number) => `Watching ${done} of ${total}`,
  estimate: "Usually 1 to 3 minutes.",
  subscribers: (n: number | null, hidden: boolean) =>
    hidden || n === null ? "Subscriber count hidden" : `${compact(n)} subscribers`,

  windowSummary: (from: string, to: string, eligible: number) =>
    `${eligible} Shorts from ${day(from)} to ${day(to)}`,
  scatterTitle: "Shorts by date and outlier score",
  scatterAxisY: "Outlier score (Match Cut's calculation)",
  medianLine: "channel median",
  scoreHow: "How is the outlier score calculated?",
  scoreFormula:
    "A Short's views divided by the channel's median views, counting Shorts at least 7 days old. A score of 2 or more counts as a breakout. It's Match Cut's own calculation, not a YouTube metric.",
  legendBreakout: "Breakout (compared)",
  legendTypical: "Typical (compared)",
  legendOther: "Other Shorts",
  notPlotted: (n: number) => `${n} uploads under 7 days old aren't plotted.`,
  showTable: "Show as a table",
  tableTitle: "Title",
  tableDate: "Published",
  tableViews: "Views",
  tableScore: "Score",
  tableGroup: "Group",
  groupNames: { outlier: "Breakout", typical: "Typical", other: "Other" } as Record<string, string>,

  rulesTitle: "What the breakouts share",
  rulesCaveat:
    "Patterns the breakout Shorts share that the typical ones don't. They show what goes together, not proof of what caused the views.",
  noRules: "No edit pattern sets this channel's breakouts apart from its typical Shorts.",
  confidence: { high: "High confidence", medium: "Medium confidence" } as Record<string, string>,
  evidence: (ow: number, ok: number, tw: number, tk: number) =>
    `${ow} of ${ok} breakouts · ${tw} of ${tk} typical`,
  watchExample: (title: string, at: string) => `Watch ${title} at ${at}`,
  counterexample: "Breaks the rule:",
  playerTitle: "Example Short",
  houseStyleTitle: "House style",
  houseStyleNone: "Nothing stood out that every Short on this channel does.",
  notExplainedTitle: "What the edit doesn't explain",

  notEnoughTitle: "Not enough recent Shorts to compare",
  reasons: {
    TOO_FEW_SHORTS: "Too few recent Shorts",
    TOO_FEW_BREAKOUTS: "Too few breakouts",
    TOO_FEW_TYPICAL: "Too few typical Shorts",
    NO_VIEWS: "No view counts",
  } as Record<string, string>,
  found: (n: number, min: number, what: string) => `${what}: ${n} found, ${min} needed`,
  foundShorts: "Shorts at least 7 days old",
  foundBreakouts: "Breakouts",
  foundTypical: "Typical Shorts",
  tryLonger: "Try 180 days",
  singleVideo: "Analyze a single video instead",

  applyTitle: "Use it for your video",
  goalLabel: "What are you making?",
  goalPlaceholder: "A 30-second video about my coffee cart",
  formatLabel: "Format",
  formatMatch: "9:16, like the channel's Shorts",
  lengthLabel: "Length (seconds)",
  lengthAny: "Any",
  apply: "Write my prompt",
  applying: "Writing your prompt…",
  promptTitle: "Your Cardboard prompt",
  shotsTitle: "What to film",
  shotLine: (seconds: number, framing: string) => `${seconds} s · ${framing}`,

  saveTitle: "Save as a skill",
  saveHelp: "Keep these rules to reuse for other videos, even after this playbook expires.",
  nameLabel: "Skill name",
  save: "Save skill",
  saved: "Saved. Find it under Skills.",
  newPlaybook: "Build another playbook",
  cancel: "Cancel",
  cancelled: "Playbook cancelled.",
  timedOut: "This is taking longer than usual. Check back in a few minutes.",

  skillsTitle: "Skills",
  skillsIntro: "Saved playbooks and briefs you can apply to new videos.",
  skillsEmpty: "No skills yet. Build a playbook and save it as a skill to reuse it here.",
  skillFrom: (type: string, title: string | null) =>
    `From a ${type === "playbook" ? "playbook" : "brief"}${title ? `: ${title}` : ""}`,
  lastUsed: (iso: string | null) => (iso ? `Last used ${day(iso)}` : "Not used yet"),
  applySkill: "Apply",
  deleteSkill: "Delete",
  deleteSkillConfirm: (name: string) => `Delete the skill "${name}"?`,
  navPlaybooks: "Playbooks",
  navSkills: "Skills",
  navEditor: "Editor",
} as const;

export function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function compact(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    n,
  );
}
