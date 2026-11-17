/**
 * YouTube link parsing. PRD: "Backend: input validation and edge cases > URL and source".
 * Pure and browser-safe: the web app imports this for validation as the user types.
 */
import type { ErrorCode, WarningCode } from "./errors.js";

export const MAX_URL_LENGTH = 2048;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export type ParsedSource =
  | { ok: true; videoId: string; canonicalUrl: string; warnings: WarningCode[] }
  | { ok: false; code: Extract<ErrorCode, "INVALID_URL" | "UNSUPPORTED_SOURCE"> };

const invalid = { ok: false, code: "INVALID_URL" } as const;
const unsupported = { ok: false, code: "UNSUPPORTED_SOURCE" } as const;

/** The only URL ever sent to Gemini. Always rebuilt from a validated ID. */
export function canonicalYouTubeUrl(videoId: string): string {
  if (!ID_RE.test(videoId)) throw new Error(`Not a YouTube video ID: ${videoId}`);
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function isVideoId(value: string): boolean {
  return ID_RE.test(value);
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);
// Path prefixes where the next segment is the video ID.
const ID_PATHS = new Set(["shorts", "embed", "live", "v"]);

function ok(videoId: string, url: URL | null): ParsedSource {
  if (!ID_RE.test(videoId)) return invalid;
  const warnings: WarningCode[] = [];
  if (
    url &&
    (url.searchParams.has("t") ||
      url.searchParams.has("start") ||
      /(^|&)t=/.test(url.hash.slice(1)))
  ) {
    warnings.push("TIMESTAMP_IGNORED");
  }
  return { ok: true, videoId, canonicalUrl: canonicalYouTubeUrl(videoId), warnings };
}

export function parseYouTubeSource(input: string): ParsedSource {
  if (typeof input !== "string" || input.length > MAX_URL_LENGTH) return invalid;
  const raw = input.trim();
  if (raw === "" || /\s/.test(raw)) return invalid;

  // Bare video ID.
  if (ID_RE.test(raw)) return ok(raw, null);

  // Anything without a dot or scheme can't be a link (e.g. "hello", or a 10-character ID).
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!hasScheme && !raw.includes(".")) return invalid;

  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return invalid;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return invalid;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".")) return invalid;

  const segments = url.pathname.split("/").filter(Boolean);

  if (SHORT_HOSTS.has(host)) {
    const id = segments[0];
    return id ? ok(id, url) : invalid;
  }

  // Any other host, including link shorteners: never followed (no server-side redirects).
  if (!YOUTUBE_HOSTS.has(host)) return unsupported;

  const first = segments[0]?.toLowerCase();
  if (first === "watch") {
    const v = url.searchParams.get("v");
    return v === null ? unsupported : ok(v, url);
  }
  if (first && ID_PATHS.has(first)) {
    const id = segments[1];
    return id ? ok(id, url) : unsupported;
  }
  // Playlist without v=, channel, @handle, search results, home page, anything else.
  return unsupported;
}
