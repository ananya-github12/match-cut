/**
 * PRD "Cache store down: bypass cache; log the miss". Wraps a KV so a Redis outage degrades to
 * cache misses (and fail-open coordination) instead of failing requests.
 */
import type { KV } from "./types.js";

export class SafeKV implements KV {
  private lastLog = 0;
  constructor(
    private readonly inner: KV,
    private readonly log: (msg: string) => void = (m) => console.warn(m),
  ) {}

  private miss(op: string, err: unknown): void {
    // At most one log line every 10 s while the store is down.
    const now = Date.now();
    if (now - this.lastLog > 10_000) {
      this.lastLog = now;
      this.log(`[cache] store unavailable during ${op}; bypassing (${(err as Error).message})`);
    }
  }

  async get(key: string) {
    try {
      return await this.inner.get(key);
    } catch (e) {
      this.miss("get", e);
      return null;
    }
  }
  async set(key: string, value: string, ttl: number) {
    try {
      await this.inner.set(key, value, ttl);
    } catch (e) {
      this.miss("set", e);
    }
  }
  /** Fails open: if the store is down, the caller proceeds as if it won the key. */
  async setIfAbsent(key: string, value: string, ttl: number) {
    try {
      return await this.inner.setIfAbsent(key, value, ttl);
    } catch (e) {
      this.miss("setIfAbsent", e);
      return true;
    }
  }
  async del(key: string) {
    try {
      await this.inner.del(key);
    } catch (e) {
      this.miss("del", e);
    }
  }
  /** Fails open with 0 so rate limits and spend checks don't block while the store is down. */
  async incrBy(key: string, by: number, ttl: number) {
    try {
      return await this.inner.incrBy(key, by, ttl);
    } catch (e) {
      this.miss("incrBy", e);
      return 0;
    }
  }
}
