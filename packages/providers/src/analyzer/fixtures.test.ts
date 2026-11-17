import { checkPass1, normalizePass1 } from "@match-cut/core";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MOCK_VIDEOS } from "../youtube/mock.js";

const dir = new URL("../../fixtures/pass1/", import.meta.url);
const durations: Record<string, number> = Object.fromEntries(
  Object.values(MOCK_VIDEOS).map((v) => [v.id, v.durationSeconds]),
);

describe("pass 1 fixtures", () => {
  // Found by the eval runner: a fixture that breaks the checks silently became a different video.
  it.each(readdirSync(dir).filter((f) => f.endsWith(".json")))(
    "%s passes every pass 1 check",
    (file) => {
      const raw = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
      const id = file.replace(/\.json$/, "");
      const mm = /^(\d+):(\d{2})$/.exec(raw.format.duration);
      const seconds = durations[id] ?? (mm ? Number(mm[1]) * 60 + Number(mm[2]) : null);
      const r = checkPass1(normalizePass1(raw), seconds);
      expect(r.problems).toEqual([]);
    },
  );
});

describe("fitFixtureToLength (hybrid mode: mock analysis of real videos)", () => {
  it.each([23, 35, 66, 480])(
    "a %ss video gets a breakdown that passes the pass 1 checks",
    async (seconds) => {
      const { MockAnalyzer } = await import("./mock.js");
      const res = await new MockAnalyzer().watch({
        videoId: "SU1QGhP-pkI",
        canonicalUrl: "https://www.youtube.com/watch?v=SU1QGhP-pkI",
        range: null,
        detail: "standard",
        model: "m",
        durationSeconds: seconds,
      });
      const r = checkPass1(normalizePass1(res.output), seconds);
      expect(r.problems).toEqual([]);
    },
  );
});
