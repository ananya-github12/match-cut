/**
 * Channel input for playbooks. PRD-playbooks.md, Feature 3 > Input: a handle (@name), a channel
 * URL (/@name, /channel/UC…, /user/name) or any video URL from the channel. Only the parsed
 * handle, channel ID or video ID is ever used; the user's raw URL is never forwarded.
 * Pure and browser-safe.
 */
import type { ErrorCode } from "./errors.js";
import { MAX_URL_LENGTH, parseYouTubeSource } from "./youtube-url.js";

export type ChannelRef =
  /** Without the leading @. */
  | { kind: "handle"; handle: string }
  | { kind: "id"; channelId: string }
  /** Legacy /user/name URLs. */
  | { kind: "username"; username: string }
  /** Any video on the channel: resolved to its channel. */
  | { kind: "video"; videoId: string };

export type ParsedChannel =
  | { ok: true; ref: ChannelRef }
  | { ok: false; code: Extract<ErrorCode, "INVALID_URL" | "UNSUPPORTED_SOURCE"> };

/**
 * YouTube handles: 3 to 30 characters in any script: letters (with combining marks), digits,
 * underscores, hyphens and periods, starting with a letter or digit. Input is NFKC-normalized
 * first, so full-width forms match their plain equivalents.
 */
const HANDLE_RE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.-]{2,29}$/u;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const USERNAME_RE = /^[A-Za-z0-9]{1,40}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

const invalid = { ok: false, code: "INVALID_URL" } as const;
const unsupported = { ok: false, code: "UNSUPPORTED_SOURCE" } as const;

export function isChannelId(value: string): boolean {
  return CHANNEL_ID_RE.test(value);
}

export function isHandle(value: string): boolean {
  return HANDLE_RE.test(value);
}

/** Canonical channel page for display and links; built from a validated handle or ID only. */
export function canonicalChannelUrl(ref: { handle: string } | { channelId: string }): string {
  if ("handle" in ref) {
    if (!isHandle(ref.handle)) throw new Error(`Not a YouTube handle: ${ref.handle}`);
    return `https://www.youtube.com/@${encodeURIComponent(ref.handle)}`;
  }
  if (!isChannelId(ref.channelId)) throw new Error(`Not a channel ID: ${ref.channelId}`);
  return `https://www.youtube.com/channel/${ref.channelId}`;
}

/** Decodes percent-encoding once; null if it's malformed. */
function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function handleRef(raw: string): ParsedChannel {
  const decoded = decode(raw);
  if (decoded === null) return invalid;
  const handle = decoded.normalize("NFKC");
  return isHandle(handle) ? { ok: true, ref: { kind: "handle", handle } } : invalid;
}

export function parseChannelSource(input: string): ParsedChannel {
  if (typeof input !== "string" || input.length > MAX_URL_LENGTH) return invalid;
  const raw = input.trim();
  if (raw === "" || /\s/.test(raw)) return invalid;

  // Bare @handle or channel ID.
  if (raw.startsWith("@")) return handleRef(raw.slice(1));
  if (isChannelId(raw)) return { ok: true, ref: { kind: "id", channelId: raw } };

  // A video link or bare video ID: the playbook uses that video's channel.
  const video = parseYouTubeSource(raw);
  if (video.ok) return { ok: true, ref: { kind: "video", videoId: video.videoId } };

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!hasScheme && !raw.includes(".")) return invalid;
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return invalid;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return invalid;
  // "www.youtube.com." (trailing dot) is the same host.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // A youtu.be link that isn't a valid video link is a broken video link, not a channel.
  if (host === "youtu.be" || host === "www.youtu.be") return invalid;
  if (!YOUTUBE_HOSTS.has(host)) return unsupported;

  const segments = url.pathname.split("/").filter(Boolean);
  const raw0 = segments[0];
  if (!raw0) return unsupported;
  const first = decode(raw0);
  if (first === null) return invalid;
  // /@handle, /%40handle, /@handle/shorts, /@handle/videos …
  if (first.startsWith("@")) return handleRef(first.slice(1));
  const keyword = first.toLowerCase();
  if (keyword === "channel") {
    const id = segments[1];
    return id && isChannelId(id) ? { ok: true, ref: { kind: "id", channelId: id } } : invalid;
  }
  if (keyword === "user") {
    const name = segments[1];
    return name && USERNAME_RE.test(name)
      ? { ok: true, ref: { kind: "username", username: name } }
      : invalid;
  }
  // /c/name custom URLs can't be resolved without a search, playlists, search pages, home page.
  return unsupported;
}
