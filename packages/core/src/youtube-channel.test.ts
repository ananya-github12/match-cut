import { describe, expect, it } from "vitest";
import {
  canonicalChannelUrl,
  isChannelId,
  parseChannelSource,
  type ChannelRef,
} from "./youtube-channel.js";

const ID = "UCaBcDeFgHiJkLmNoPqRsTuV"; // UC + 22
const ok = (ref: ChannelRef) => ({ ok: true, ref });

describe("parseChannelSource (PRD-playbooks.md, Feature 3 > Input)", () => {
  it.each([
    ["@mkbhd", { kind: "handle", handle: "mkbhd" }],
    ["@Some.Creator_99", { kind: "handle", handle: "Some.Creator_99" }],
    ["https://www.youtube.com/@mkbhd", { kind: "handle", handle: "mkbhd" }],
    ["youtube.com/@mkbhd/shorts", { kind: "handle", handle: "mkbhd" }],
    ["https://m.youtube.com/@mkbhd/videos?view=0", { kind: "handle", handle: "mkbhd" }],
    [
      "https://www.youtube.com/@%E0%A4%B9%E0%A4%BF%E0%A4%82%E0%A4%A6%E0%A5%80",
      {
        kind: "handle",
        handle: "हिंदी",
      },
    ],
    [ID, { kind: "id", channelId: ID }],
    [`https://www.youtube.com/channel/${ID}`, { kind: "id", channelId: ID }],
    [`https://youtube.com/channel/${ID}/shorts`, { kind: "id", channelId: ID }],
    [
      "https://www.youtube.com/user/GoogleDevelopers",
      {
        kind: "username",
        username: "GoogleDevelopers",
      },
    ],
    ["https://youtu.be/dQw4w9WgXcQ", { kind: "video", videoId: "dQw4w9WgXcQ" }],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", { kind: "video", videoId: "dQw4w9WgXcQ" }],
    ["dQw4w9WgXcQ", { kind: "video", videoId: "dQw4w9WgXcQ" }],
  ] as [string, ChannelRef][])("%s", (input, ref) => {
    expect(parseChannelSource(input)).toEqual(ok(ref));
  });

  it.each([
    "",
    "   ",
    "not a channel",
    "@ab", // handles need 3+ characters
    `@${"a".repeat(31)}`,
    "@bad/handle",
    "@%E0%A4", // broken percent-encoding
    "https://www.youtube.com/channel/UCshort",
    "https://www.youtube.com/user/bad name",
    "ftp://youtube.com/@mkbhd",
    "x".repeat(2049),
  ])("INVALID_URL: %j", (input) => {
    expect(parseChannelSource(input)).toEqual({ ok: false, code: "INVALID_URL" });
  });

  it.each([
    "https://www.youtube.com/c/SomeCustomName",
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/results?search_query=shorts",
    "https://www.youtube.com/",
    "https://www.tiktok.com/@creator",
    "https://www.instagram.com/creator/",
    "https://vimeo.com/123",
  ])("UNSUPPORTED_SOURCE: %s", (input) => {
    expect(parseChannelSource(input)).toEqual({ ok: false, code: "UNSUPPORTED_SOURCE" });
  });
});

describe("canonicalChannelUrl", () => {
  it("builds links from validated handles and IDs only", () => {
    expect(canonicalChannelUrl({ handle: "mkbhd" })).toBe("https://www.youtube.com/@mkbhd");
    expect(canonicalChannelUrl({ channelId: ID })).toBe(`https://www.youtube.com/channel/${ID}`);
    expect(() => canonicalChannelUrl({ handle: "bad/handle" })).toThrow();
    expect(() => canonicalChannelUrl({ channelId: "UCnope" })).toThrow();
  });
  it("recognizes channel IDs", () => {
    expect(isChannelId(ID)).toBe(true);
    expect(isChannelId(`${ID}x`)).toBe(false);
    expect(isChannelId("UUaBcDeFgHiJkLmNoPqRsTuV")).toBe(false);
  });
});

describe("parseChannelSource edge cases (review fixes)", () => {
  it.each([
    ["https://www.youtube.com/%40mkbhd", { kind: "handle", handle: "mkbhd" }],
    ["https://www.youtube.com./@mkbhd", { kind: "handle", handle: "mkbhd" }],
    ["https://user:pw@www.youtube.com:8443/@mkbhd", { kind: "handle", handle: "mkbhd" }],
    ["@ＭＫＢＨＤ", { kind: "handle", handle: "MKBHD" }],
    [`https://www.youtube.com/Channel/${ID}`, { kind: "id", channelId: ID }],
    [
      "https://www.youtube.com/USER/GoogleDevelopers",
      {
        kind: "username",
        username: "GoogleDevelopers",
      },
    ],
  ] as [string, ChannelRef][])("%s", (input, ref) => {
    expect(parseChannelSource(input)).toEqual(ok(ref));
  });

  it.each(["@...", "@-_-", "@_ab", "https://youtu.be/", "https://www.youtube.com/%E0%A4"])(
    "INVALID_URL: %s",
    (input) => {
      expect(parseChannelSource(input)).toEqual({ ok: false, code: "INVALID_URL" });
    },
  );

  it("a look-alike host is not YouTube", () => {
    expect(parseChannelSource("https://youtube.com@evil.example/@mkbhd")).toEqual({
      ok: false,
      code: "UNSUPPORTED_SOURCE",
    });
  });
});
