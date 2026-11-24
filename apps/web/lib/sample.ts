/** The labeled sample result behind "See an example" (PRD empty state). Static; no API call. */
import type { BriefResponse } from "@match-cut/core/schemas";

export const SAMPLE_BRIEF: BriefResponse = {
  id: "example",
  status: "succeeded",
  stage: null,
  video: {
    id: "example",
    title: "Example: a 45-second talking-head tip",
    channel: "Example channel",
    duration_seconds: 45,
    aspect_ratio: "9:16",
    analyzed_range: {
      start_seconds: 0,
      end_seconds: 45,
    },
  },
  breakdown: {
    summary:
      "A 45-second talking-head Short that teaches one productivity tip straight to camera. It works because the payoff is promised in the first second and every 2 to 3 seconds something changes on screen.",
    video_type: "talking-head short",
    format: {
      aspect_ratio: "9:16",
      duration: "00:45",
      avg_shot_length_seconds: 2.4,
    },
    hook: "Opens mid-sentence on a tight close-up with a bold on-screen question, then a 115% punch-in on the first spoken word. No intro or logo, so the viewer is in the content within 1 second.",
    beats: [
      {
        start: "00:00",
        end: "00:03",
        label: "Question hook",
        what_happens: "Close-up, bold caption asks the question the video answers.",
      },
      {
        start: "00:03",
        end: "00:12",
        label: "Problem setup",
        what_happens: "Creator explains the common mistake; two jump cuts and one punch-in.",
      },
      {
        start: "00:12",
        end: "00:30",
        label: "Three-step tip",
        what_happens:
          "Each step gets a numbered title card overlay and a screen-recording insert of about 3 seconds.",
      },
      {
        start: "00:30",
        end: "00:40",
        label: "Proof moment",
        what_happens: "Before and after split screen with a whoosh sound effect.",
      },
      {
        start: "00:40",
        end: "00:45",
        label: "Call to action",
        what_happens: "Creator points down at the caption; music swells and cuts hard to black.",
      },
    ],
    style: {
      pacing:
        "Average shot about 2.4 s; jump cuts remove every pause over 0.3 s. Cuts land on music beats in the last 10 seconds.",
      framing:
        "Medium close-up at eye level, alternating with 110 to 120% punch-ins every second or third cut. Screen recordings fill the full frame.",
      transitions: "Hard cuts throughout, one whip pan into the proof section.",
      text_and_graphics:
        "Word-by-word captions, 2 to 4 words per line, white bold sans-serif with a yellow highlight on the active word, placed in the lower third. Numbered title cards for each step.",
      audio:
        "Low-volume lo-fi hip-hop at about 90 BPM under the voice; whoosh on transitions, a pop on each title card.",
      delivery:
        "High energy, fast speech at roughly 180 words per minute, direct eye contact, frequent hand gestures toward the captions.",
      look: "Bright, evenly lit home office, warm color grade, plant and bookshelf in the background, casual hoodie.",
    },
    signals: {
      has_speech: true,
      has_on_camera_person: true,
      has_music: true,
      has_on_screen_text: true,
    },
  },
  cardboard_prompt:
    "Edit my footage into a 30-second launch video for my budgeting app, using the structure and pacing of the reference.\n1. Rough cut: open on my strongest line within the first second, with no intro. Order the rest as question hook, then problem setup, then three-step tip, then proof moment, then call to action.\n2. Pacing: remove silences and pauses longer than 0.3 seconds. Aim for shots of about 2.4 seconds, cutting on the beat near the end.\n3. Framing: keep the 9:16 frame. Add 110 to 120 percent punch-in zooms on every second or third cut to keep energy up.\n4. Captions: add word-by-word captions, 2 to 4 words per line, bold sans-serif with the active word highlighted, in the lower third.\n5. Graphics: add a short numbered title card for each of the three tips in my footage.\n6. Music and sound: generate low-volume upbeat lo-fi music around 90 BPM under my voice, and add a whoosh on transitions and a pop when titles appear. If my footage lacks b-roll for a tip, generate it.\n7. Color: apply a warm, bright grade.\n8. Ending: target 0:30 total. Keep the hook and the call to action, and merge the problem setup into the first tip to fit. Finish on a clear call to action and cut hard to black on the last beat.",
  assets_needed: [
    "Talking-head takes of each tip, filmed vertically if possible",
    "A screen recording of the app for each tip",
  ],
  watch_outs: [
    "Write your own hook; don't reuse the reference's opening question.",
    "Pick your own music; the reference's track is not reused.",
  ],
  shot_list: [
    {
      shot: "Me asking the question my budgeting app answers, straight to camera",
      framing: "tight close-up, eye level, phone vertical",
      duration_seconds: 3,
      maps_to_beat: 1,
      notes: "Start talking in the first second; no intro.",
    },
    {
      shot: "The everyday money problem, shown with a quick reaction",
      framing: "medium shot, waist up, slightly off-center",
      duration_seconds: 5,
      maps_to_beat: 2,
      notes: "",
    },
    {
      shot: "Tip 1 to camera, then the matching screen in the app",
      framing: "close-up, then a full-screen screen recording",
      duration_seconds: 6,
      maps_to_beat: 3,
      notes: "Record the screen at the same pace you speak.",
    },
    {
      shot: "Tips 2 and 3, one take each, with the app screens",
      framing: "close-up alternating with screen recordings",
      duration_seconds: 8,
      maps_to_beat: 3,
      notes: "",
    },
    {
      shot: "A result: the app's monthly summary after a week of use",
      framing: "screen recording, then a quick close-up smile",
      duration_seconds: 5,
      maps_to_beat: 4,
      notes: "",
    },
    {
      shot: "Call to action: where to download, one line",
      framing: "tight close-up, eye level",
      duration_seconds: 3,
      maps_to_beat: 5,
      notes: "End on a clear line; the edit cuts hard to black.",
    },
  ],
  warnings: [],
  error: null,
  meta: {
    model: "example",
    prompt_version: "p1.v1+p2.v1",
    schema_version: "s1",
    cached: true,
    timings_ms: {
      total: 18000,
    },
    tokens: {},
    created_at: "2026-11-17T00:00:00.000Z",
  },
};
