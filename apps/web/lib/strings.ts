/**
 * All user-facing copy (PRD "Localization: all copy in string files"). Error and warning messages
 * come from @match-cut/core/errors, which holds the PRD's message tables verbatim.
 */
export const S = {
  appName: "Match Cut",
  chatTitle: "AI Chat",
  chatPlaceholder: "Ask Cardboard to edit, or paste a YouTube link…",
  chatSend: "Send",
  matchAction: "Match a reference",
  pasteCardTitle: "Match this video's style?",
  pasteCardMatch: "Match",
  pasteCardDismiss: "Dismiss",

  emptyTitle:
    "Show Cardboard a video you like, and get an edit prompt that recreates its style with your footage.",
  emptySteps: [
    "Paste a reference: any public YouTube video.",
    "Say what you're making.",
    "Run the prompt with your footage.",
  ],
  seeExample: "See an example",
  exampleLabel: "Example result",

  linkLabel: "Reference link",
  linkPlaceholder: "https://youtube.com/shorts/…",
  goalLabel: "What are you making?",
  goalHelp: "Optional. Don't include personal data.",
  goalPlaceholder: "A 30-second launch video for my budgeting app",
  formatLabel: "Format",
  lengthLabel: "Length",
  sameAsReference: "Same as reference",
  clipLabel: "Clip range",
  clipStart: "Start",
  clipEnd: "End",
  clipHelp: "mm:ss or h:mm:ss. Only this part is studied.",
  clipRequired: "Pick the part you want, up to 10 minutes.",
  clipSuggested: "This video is over 3 minutes. A clip range makes analysis faster.",
  clipInvalid: "Use mm:ss or h:mm:ss, like 1:05.",
  advancedLabel: "Advanced",
  languageLabel: "Output language",
  detailLabel: "Detail level",
  detailStandard: "Standard",
  detailDeep: "Deep",
  detailDeepNote: "slower, more precise",
  primary: "Match this style",
  checkingLink: "Checking the link…",

  stages: {
    queued: "Checking the video",
    prechecking: "Checking the video",
    watching: "Watching the reference",
    writing_prompt: "Writing your prompt",
    validating: "Checking the result",
  } as Record<string, string>,
  estimateShort: "Usually 15 to 40 seconds for a Short",
  estimateMedium: "Usually 30 to 60 seconds",
  estimateLong: "Usually 1 to 2 minutes",
  elapsed: (s: number) => `${s}s`,
  cancel: "Cancel",
  keepWorking: "You can keep working while this runs.",

  promptTitle: "Your Cardboard prompt",
  sendToDirector: "Send to Director",
  copy: "Copy",
  copied: "Copied",
  regenerate: "Regenerate",
  regenerating: "Writing a new prompt…",
  resetToOriginal: "Reset to original",
  regenerateTitle: "Change the inputs and write a new prompt",
  regenerateGo: "Write new prompt",
  regenerateEditedWarning: "Your edits to the prompt will be replaced.",
  readOnlyMobile: "Editing is available on desktop.",

  breakdownTitle: "How the reference is made",
  rows: {
    video_type: "Type",
    hook: "Hook",
    pacing: "Pacing",
    framing: "Framing",
    transitions: "Transitions",
    text_and_graphics: "Text and graphics",
    audio: "Audio",
    delivery: "Delivery",
    look: "Look",
  } as Record<string, string>,
  beatsLabel: "Beats",
  assetsTitle: "Before you start",
  shotListTitle: "What to film",
  shotListHint: (count: number, seconds: number) =>
    `${count} shots, about ${Math.round(seconds)} s on screen in total. Film these, then run the prompt above on your footage.`,
  shotSeconds: (seconds: number) => `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`,
  shotBeat: (label: string) => `Recreates "${label}"`,
  shotBeatAria: (label: string) => `Play the reference's "${label}" beat`,
  watchOutsTitle: "Watch-outs",
  openOnYouTube: "Open on YouTube",
  playerTitle: "Reference video",

  footerMeta: (model: string, seconds: number | null) =>
    seconds === null ? `${model}` : `${model} · ${seconds < 1 ? "<1" : Math.round(seconds)} s`,
  helpful: "Helpful",
  notHelpful: "Not helpful",
  feedbackThanks: "Thanks for the feedback.",
  feedbackReasons: {
    inaccurate: "Inaccurate",
    too_generic: "Too generic",
    unsupported: "Asked for things Cardboard can't do",
    other: "Other",
  } as Record<string, string>,
  feedbackDetails: "Anything else? (optional)",
  feedbackSubmit: "Send feedback",
  deleteBrief: "Delete brief",
  deleteConfirmTitle: "Delete this brief?",
  deleteConfirmBody: "The prompt and breakdown will be removed from Match Cut and from this chat.",
  deleteConfirm: "Delete",
  deleteCancel: "Keep it",
  startOver: "Start over",
  backToChat: "Back to chat",

  partial: "The breakdown is ready, but the prompt didn't finish.",
  regeneratePrompt: "Regenerate prompt",
  offline: "You're offline. Match Cut needs an internet connection.",
  offlineWaiting: "You're offline. We'll pick up where we left off when you're back.",
  retryWhenOnline: "Retry when back online",

  actions: {
    focusLink: "Fix the link",
    openClip: "Open clip range",
    focusGoal: "Edit the description",
    signIn: "Sign in again",
    tryAnother: "Try another link",
    retry: "Retry",
    countdown: (s: number) =>
      `Try again in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`,
  },

  directorAck:
    "Got it. I'll plan the edit on your footage. (In this demo, Cardboard's Director is a stub, so nothing is edited.)",
  directorStudying: "I'm studying that video so I can match its style.",
  directorGeneric:
    "In this demo I can match a reference video. Paste a YouTube link, or use Match a reference.",
} as const;

export const LANGUAGES: { tag: string; name: string }[] = [
  { tag: "en", name: "English" },
  { tag: "hi", name: "Hindi" },
  { tag: "es", name: "Spanish" },
  { tag: "pt-BR", name: "Portuguese (Brazil)" },
  { tag: "fr", name: "French" },
  { tag: "de", name: "German" },
  { tag: "ja", name: "Japanese" },
  { tag: "ko", name: "Korean" },
  { tag: "id", name: "Indonesian" },
];

export const FORMATS = [
  { value: "9:16", label: "9:16 vertical" },
  { value: "16:9", label: "16:9 horizontal" },
  { value: "1:1", label: "1:1 square" },
  { value: "4:5", label: "4:5 portrait" },
  { value: "match", label: S.sameAsReference },
] as const;

export const LENGTHS = [
  { value: "15", label: "15 s" },
  { value: "30", label: "30 s" },
  { value: "60", label: "60 s" },
  { value: "150", label: "2 to 3 min" },
  { value: "match", label: S.sameAsReference },
] as const;
