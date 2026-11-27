/**
 * Postgres rejects U+0000 in text and jsonb, and lone UTF-16 surrogates aren't valid UTF-8.
 * YouTube titles and model output are arbitrary text, so one bad character could fail a whole
 * save. Both become U+FFFD, in every string of a value, before it's written.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// eslint-disable-next-line no-control-regex
const NUL = /\u0000/g;
const REPLACEMENT = "�";

export function storageSafeString(s: string): string {
  return s.replace(LONE_SURROGATE, REPLACEMENT).replace(NUL, REPLACEMENT);
}

export function storageSafe<T>(value: T): T {
  if (typeof value === "string") return storageSafeString(value) as T;
  if (Array.isArray(value)) return value.map((v) => storageSafe(v)) as T;
  if (value instanceof Date || value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, storageSafe(v)]),
  ) as T;
}

/** A patch without its undefined keys: "not given" must never clear a field. */
export function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}
