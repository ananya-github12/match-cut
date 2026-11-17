import { describe, expect, it } from "vitest";
import { formatMmSs, formatTimecode, parseIsoDuration, parseTimecode } from "./timecode.js";

describe("parseTimecode", () => {
  it("accepts seconds, m:ss and h:mm:ss", () => {
    expect(parseTimecode("75")).toBe(75);
    expect(parseTimecode("1:15")).toBe(75);
    expect(parseTimecode("01:15")).toBe(75);
    expect(parseTimecode("1:01:15")).toBe(3675);
    expect(parseTimecode(" 0:03 ")).toBe(3);
  });
  it("rejects malformed input", () => {
    for (const bad of ["", "1:75", "a:10", "1:2:3:4", "-5", "1.5", "1:5"]) {
      expect(parseTimecode(bad), bad).toBeNull();
    }
  });
});

describe("formatting", () => {
  it("formats display timecodes", () => {
    expect(formatTimecode(3)).toBe("0:03");
    expect(formatTimecode(75)).toBe("1:15");
    expect(formatTimecode(3675)).toBe("1:01:15");
  });
  it("formats breakdown mm:ss", () => {
    expect(formatMmSs(3)).toBe("00:03");
    expect(formatMmSs(605)).toBe("10:05");
  });
});

describe("parseIsoDuration", () => {
  it("parses YouTube Data API durations", () => {
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("PT3M2S")).toBe(182);
    expect(parseIsoDuration("PT1H")).toBe(3600);
    expect(parseIsoDuration("P1DT2S")).toBe(86402);
    expect(parseIsoDuration("P0D")).toBe(0);
  });
  it("rejects malformed durations", () => {
    expect(parseIsoDuration("P")).toBeNull();
    expect(parseIsoDuration("PT")).toBeNull();
    expect(parseIsoDuration("3:00")).toBeNull();
  });
});
