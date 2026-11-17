/** Goal text encryption at rest (PRD data handling): AES-256-GCM, "v1:" + base64(iv|tag|ct). */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function goalKeyFrom(base64Key: string | undefined, devFallback: string): Buffer {
  if (base64Key) return Buffer.from(base64Key, "base64");
  // Development only (env validation requires a real key in production).
  return createHash("sha256").update(`match-cut-dev-goal-key:${devFallback}`).digest();
}

export function encryptText(plain: string, key: Buffer): string {
  if (plain === "") return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

/** Decrypts "v1:" values; anything else is returned as is (rows written before encryption). */
export function decryptText(stored: string, key: Buffer): string {
  if (!stored.startsWith("v1:")) return stored;
  const raw = Buffer.from(stored.slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/**
 * Decrypts with the current key, then any previous keys (key rotation). If none works, returns
 * null instead of throwing, so one unreadable row can't break listings and ops checks.
 */
export function decryptWithAny(stored: string, keys: Buffer[]): string | null {
  for (const key of keys) {
    try {
      return decryptText(stored, key);
    } catch {
      // try the next key
    }
  }
  return null;
}

/** Parses GOAL_ENCRYPTION_KEY_PREVIOUS (comma-separated base64 keys). */
export function previousKeysFrom(value: string | undefined): Buffer[] {
  return (value ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => Buffer.from(k, "base64"))
    .filter((k) => k.length === 32);
}
