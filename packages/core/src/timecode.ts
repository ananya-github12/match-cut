/** Timecode helpers. The API takes integer seconds only; parsing user input belongs to clients. */

/** Parses "75", "1:15" or "1:01:15" into seconds. Returns null when malformed. */
export function parseTimecode(input: string): number | null {
  const s = input.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/.exec(s);
  if (!m) return null;
  const [, h, min, sec] = m;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec);
}

/** Formats seconds as m:ss, or h:mm:ss from one hour up. Used for display in every locale. */
export function formatTimecode(totalSeconds: number): string {
  const t = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Formats seconds as mm:ss (minutes may exceed 59). The breakdown's timestamp format. */
export function formatMmSs(totalSeconds: number): string {
  const t = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** Parses an ISO 8601 duration from the YouTube Data API (e.g. "PT1H2M3S", "P1DT2S", "P0D"). */
export function parseIsoDuration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m || iso === "P" || iso.endsWith("T")) return null;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}
