import { describe, expect, it } from "vitest";
import { canonicalYouTubeUrl, MAX_URL_LENGTH, parseYouTubeSource } from "./youtube-url.js";

const ID = "dQw4w9WgXcQ";
const CANON = `https://www.youtube.com/watch?v=${ID}`;

function expectId(input: string, warnings: string[] = []) {
  const r = parseYouTubeSource(input);
  expect(r, input).toEqual({ ok: true, videoId: ID, canonicalUrl: CANON, warnings });
}
function expectError(input: string, code: "INVALID_URL" | "UNSUPPORTED_SOURCE") {
  expect(parseYouTubeSource(input), input).toEqual({ ok: false, code });
}

// One describe per row of the PRD's "URL and source" table.
describe("URL and source (PRD table)", () => {
  it("row 1: watch, youtu.be, shorts, embed, live, m. and music. links are accepted", () => {
    expectId(`https://www.youtube.com/watch?v=${ID}`);
    expectId(`https://youtube.com/watch?v=${ID}`);
    expectId(`https://youtu.be/${ID}`);
    expectId(`https://www.youtube.com/shorts/${ID}`);
    expectId(`https://www.youtube.com/embed/${ID}`);
    expectId(`https://www.youtube-nocookie.com/embed/${ID}`);
    expectId(`https://www.youtube.com/live/${ID}`);
    expectId(`https://m.youtube.com/watch?v=${ID}`);
    expectId(`https://music.youtube.com/watch?v=${ID}`);
    expectId(`https://WWW.YouTube.com/Shorts/${ID}`);
  });

  it("row 2: a bare 11-character ID is accepted", () => {
    expectId(ID);
    expect(parseYouTubeSource("abc_DEF-123")).toMatchObject({ ok: true, videoId: "abc_DEF-123" });
  });

  it("row 3: extra parameters (si, feature, utm_*) are ignored", () => {
    expectId(`https://youtu.be/${ID}?si=AbCdEf123`);
    expectId(`https://www.youtube.com/watch?v=${ID}&feature=share`);
    expectId(`https://www.youtube.com/shorts/${ID}?utm_source=x&utm_medium=y&utm_campaign=z`);
  });

  it("row 4: a t= or start= timestamp is ignored with a TIMESTAMP_IGNORED warning", () => {
    expectId(`https://youtu.be/${ID}?t=42`, ["TIMESTAMP_IGNORED"]);
    expectId(`https://www.youtube.com/watch?v=${ID}&t=1m30s`, ["TIMESTAMP_IGNORED"]);
    expectId(`https://www.youtube.com/embed/${ID}?start=30`, ["TIMESTAMP_IGNORED"]);
    expectId(`https://www.youtube.com/watch?v=${ID}#t=30`, ["TIMESTAMP_IGNORED"]);
  });

  it("row 5: a playlist URL with v= analyzes the single video and ignores list", () => {
    expectId(`https://www.youtube.com/watch?v=${ID}&list=PL1234567890abcdef&index=3`);
  });

  it("row 6: playlist without v=, channel, @handle and search results are unsupported", () => {
    expectError("https://www.youtube.com/playlist?list=PL1234567890abcdef", "UNSUPPORTED_SOURCE");
    expectError("https://www.youtube.com/watch?list=PL1234567890abcdef", "UNSUPPORTED_SOURCE");
    expectError("https://www.youtube.com/channel/UC1234567890abcdefghijkl", "UNSUPPORTED_SOURCE");
    expectError("https://www.youtube.com/c/SomeCreator", "UNSUPPORTED_SOURCE");
    expectError("https://www.youtube.com/user/somecreator", "UNSUPPORTED_SOURCE");
    expectError("https://www.youtube.com/@somecreator", "UNSUPPORTED_SOURCE");
    expectError("https://www.youtube.com/@somecreator/videos", "UNSUPPORTED_SOURCE");
    expectError("https://www.youtube.com/results?search_query=editing", "UNSUPPORTED_SOURCE");
    expectError("https://www.youtube.com/", "UNSUPPORTED_SOURCE");
  });

  it("row 7: Instagram, TikTok, Vimeo and any other host are unsupported", () => {
    expectError("https://www.instagram.com/reel/Cabc123/", "UNSUPPORTED_SOURCE");
    expectError("https://www.tiktok.com/@user/video/7234567890123456789", "UNSUPPORTED_SOURCE");
    expectError("https://vimeo.com/123456789", "UNSUPPORTED_SOURCE");
    expectError("https://example.com/watch?v=" + ID, "UNSUPPORTED_SOURCE");
    expectError("https://youtube.com.evil.example/watch?v=" + ID, "UNSUPPORTED_SOURCE");
  });

  it("row 8: shortened links are unsupported and never followed", () => {
    expectError("https://bit.ly/3abcXYZ", "UNSUPPORTED_SOURCE");
    expectError("https://tinyurl.com/abc123", "UNSUPPORTED_SOURCE");
    expectError("https://t.co/abc123", "UNSUPPORTED_SOURCE");
  });

  it("row 9: leading or trailing spaces and a missing https:// are normalized", () => {
    expectId(`   https://youtu.be/${ID}  `);
    expectId(`youtu.be/${ID}`);
    expectId(`www.youtube.com/watch?v=${ID}`);
    expectId(`http://www.youtube.com/watch?v=${ID}`);
    expectId(`\n${ID}\t`);
  });

  it("row 10: malformed text, over 2,048 characters, or a wrong-length ID is INVALID_URL", () => {
    expectError("", "INVALID_URL");
    expectError("   ", "INVALID_URL");
    expectError("hello world", "INVALID_URL");
    expectError("not a link", "INVALID_URL");
    expectError("dQw4w9WgXc", "INVALID_URL"); // 10 chars
    expectError("dQw4w9WgXcQQ", "INVALID_URL"); // 12 chars
    expectError(`https://youtu.be/dQw4w9WgXc`, "INVALID_URL");
    expectError(`https://www.youtube.com/watch?v=dQw4w9WgXcQQ`, "INVALID_URL");
    expectError(`https://www.youtube.com/shorts/abc`, "INVALID_URL");
    expectError(`https://www.youtube.com/watch?v=dQw4w9Wg$cQ`, "INVALID_URL");
    expectError("ftp://youtube.com/watch?v=" + ID, "INVALID_URL");
    expectError("javascript:alert(1)", "INVALID_URL");
    expectError(
      `https://www.youtube.com/watch?v=${ID}&x=${"a".repeat(MAX_URL_LENGTH)}`,
      "INVALID_URL",
    );
  });
});

describe("canonicalYouTubeUrl", () => {
  it("rebuilds the URL from the ID only", () => {
    expect(canonicalYouTubeUrl(ID)).toBe(CANON);
  });
  it("refuses anything that isn't an ID", () => {
    expect(() => canonicalYouTubeUrl("../../etc")).toThrow();
  });
});
