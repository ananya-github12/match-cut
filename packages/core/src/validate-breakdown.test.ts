import { describe, expect, it } from "vitest";
import {
  breakdownWarnings,
  checkPass1,
  normalizePass1,
  parseLooseTimestamp,
  stripMarkdown,
} from "./validate-breakdown.js";

const valid = () => ({
  summary: "A short talking-head tip. It works because the payoff comes first.",
  video_type: "talking-head short",
  format: { aspect_ratio: "9:16", duration: "00:30", avg_shot_length_seconds: 2.5 },
  hook: "Bold question on screen in the first second.",
  beats: [
    { start: "00:00", end: "00:05", label: "Question hook", what_happens: "Close-up and caption." },
    { start: "00:05", end: "00:20", label: "The tip", what_happens: "Three quick steps." },
    { start: "00:20", end: "00:30", label: "Call to action", what_happens: "Points at caption." },
  ],
  style: {
    pacing: "2.5 s shots",
    framing: "Close-ups",
    transitions: "Hard cuts",
    text_and_graphics: "Word-by-word captions",
    audio: "Lo-fi at 90 BPM",
    delivery: "Energetic",
    look: "Bright",
  },
  signals: {
    has_speech: true,
    has_on_camera_person: true,
    has_music: true,
    has_on_screen_text: true,
  },
  spoken_lines_internal: ["Here is the tip."],
});

describe("normalizePass1", () => {
  it("rewrites timestamps as mm:ss and strips markdown", () => {
    const raw = valid();
    raw.beats[0]!.start = "0:00";
    raw.beats[1]!.end = "20";
    raw.format.duration = "0:30";
    raw.summary = "**A short** talking-head tip. It works because the payoff comes first.";
    const out = normalizePass1(raw) as ReturnType<typeof valid>;
    expect(out.beats[0]!.start).toBe("00:00");
    expect(out.beats[1]!.end).toBe("00:20");
    expect(out.format.duration).toBe("00:30");
    expect(out.summary).toBe("A short talking-head tip. It works because the payoff comes first.");
  });

  it("leaves unreadable timestamps for the checks to report", () => {
    const raw = valid();
    raw.beats[0]!.start = "unclear";
    expect((normalizePass1(raw) as ReturnType<typeof valid>).beats[0]!.start).toBe("unclear");
  });
});

describe("parseLooseTimestamp and stripMarkdown", () => {
  it("parses the formats models return", () => {
    expect(parseLooseTimestamp("7")).toBe(7);
    expect(parseLooseTimestamp("1:05")).toBe(65);
    expect(parseLooseTimestamp("01:05.5")).toBe(65);
    expect(parseLooseTimestamp("1:01:05")).toBe(3665);
    expect(parseLooseTimestamp("1:75")).toBeNull();
    expect(parseLooseTimestamp("soon")).toBeNull();
  });
  it("removes markdown but keeps the words", () => {
    expect(stripMarkdown("## Title\n- **bold** and `code` and _it_")).toBe(
      "Title\nbold and code and it",
    );
    expect(stripMarkdown("110% zoom * 2")).toBe("110% zoom * 2");
  });
});

describe("checkPass1 semantic checks (PRD post-processing step 2)", () => {
  const check = (mut: (o: ReturnType<typeof valid>) => void, analyzed: number | null = 30) => {
    const o = valid();
    mut(o);
    return checkPass1(normalizePass1(o), analyzed);
  };

  it("passes a valid breakdown", () => {
    expect(check(() => {})).toMatchObject({ ok: true, problems: [] });
  });
  it("reports schema problems by path", () => {
    const r = check((o) => {
      (o as { beats: unknown[] }).beats = [o.beats[0]];
    });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/^beats/);
  });
  it("beats must be sorted", () => {
    const r = check((o) => {
      o.beats = [o.beats[1]!, o.beats[0]!, o.beats[2]!];
    });
    expect(r.problems.join()).toMatch(/in order/);
  });
  it("beats must not overlap", () => {
    const r = check((o) => {
      o.beats[1]!.start = "00:03";
    });
    expect(r.problems.join()).toMatch(/overlapping/);
  });
  it("end must be after start", () => {
    const r = check((o) => {
      o.beats[2]!.end = "00:20";
    });
    expect(r.problems.join()).toMatch(/must be after start/);
  });
  it("every timestamp within the analyzed duration (1 s tolerance)", () => {
    expect(check((o) => (o.beats[2]!.end = "00:31")).ok).toBe(true);
    expect(check((o) => (o.beats[2]!.end = "00:40")).problems.join()).toMatch(/past the end/);
  });
  it("no beat longer than 60% of the video unless 2 beats or fewer", () => {
    const long = check((o) => {
      o.beats = [
        { ...o.beats[0]!, end: "00:02" },
        { ...o.beats[1]!, start: "00:02", end: "00:25" },
        { ...o.beats[2]!, start: "00:25" },
      ];
    });
    expect(long.problems.join()).toMatch(/more than 60%/);
    const two = check((o) => {
      o.beats = [
        { ...o.beats[0]!, end: "00:25" },
        { ...o.beats[2]!, start: "00:25" },
      ];
    });
    expect(two.ok).toBe(true);
  });
  it("labels are 2 to 4 words", () => {
    expect(
      check((o) => (o.beats[0]!.label = "A very long beat label here")).problems.join(),
    ).toMatch(/2 to 4 words/);
  });
  it("spoken lines need speech", () => {
    expect(check((o) => (o.signals.has_speech = false)).problems.join()).toMatch(/has_speech/);
  });
  it("skips duration checks when the length is unknown", () => {
    expect(check((o) => (o.beats[2]!.end = "00:40"), null).ok).toBe(true);
  });
});

describe("breakdownWarnings (PRD post-processing step 5)", () => {
  it("NO_SPEECH and LOW_VISUAL_SIGNAL", () => {
    const o = valid();
    o.signals.has_speech = false;
    o.format.avg_shot_length_seconds = 45;
    expect(breakdownWarnings({ ...o, spoken_lines_internal: [] } as never)).toEqual([
      "LOW_VISUAL_SIGNAL",
      "NO_SPEECH",
    ]);
    expect(breakdownWarnings(valid() as never)).toEqual([]);
  });
});
