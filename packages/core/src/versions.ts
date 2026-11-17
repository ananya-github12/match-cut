/**
 * Versions stored on every brief and used in cache keys. Bump a version whenever the wording of
 * its prompt or the shape of its schema changes, so stale cache entries stop matching.
 */
export const PASS1_PROMPT_VERSION = "p1.v1";
// p2.v2: ask for ~220 words and one step per line (Flash-Lite wrote short, single-line prompts).
export const PASS2_PROMPT_VERSION = "p2.v2";
export const SCHEMA_VERSION = "s1";
