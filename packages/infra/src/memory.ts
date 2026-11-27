/** In-memory implementations for unit tests and lifecycle tests without Docker. */
import type {
  BriefEvents,
  BriefPatch,
  BriefRecord,
  BriefStore,
  JobData,
  JobQueue,
  KV,
  PlaybookPatch,
  PlaybookRecord,
  PlaybookStore,
  SkillPatch,
  SkillRecord,
  SkillStore,
} from "./types.js";

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryBriefStore implements BriefStore {
  readonly rows = new Map<string, BriefRecord>();
  async create(rec: BriefRecord) {
    this.rows.set(rec.id, clone(rec));
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? clone(r) : null;
  }
  async update(id: string, patch: BriefPatch) {
    const r = this.rows.get(id);
    if (!r) return null;
    const next = { ...r, ...clone(patch), updatedAt: new Date() };
    this.rows.set(id, next);
    return clone(next);
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
  async listUpdatedSince(since: Date) {
    return [...this.rows.values()].filter((r) => r.updatedAt >= since).map((r) => clone(r));
  }
  async deleteOlderThan(cutoff: Date) {
    let n = 0;
    for (const [id, r] of this.rows) {
      if (r.createdAt < cutoff) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }
}

export class MemoryKV implements KV {
  readonly data = new Map<string, { value: string; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  async get(key: string) {
    const e = this.data.get(key);
    if (!e) return null;
    if (e.expires <= this.now()) {
      this.data.delete(key);
      return null;
    }
    return e.value;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    this.data.set(key, { value, expires: this.now() + ttlSeconds * 1000 });
  }
  async setIfAbsent(key: string, value: string, ttlSeconds: number) {
    if ((await this.get(key)) !== null) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }
  async del(key: string) {
    this.data.delete(key);
  }
  async incrBy(key: string, by: number, ttlSeconds: number) {
    const current = await this.get(key);
    const next = (current === null ? 0 : Number(current)) + by;
    const expires = current === null ? this.now() + ttlSeconds * 1000 : this.data.get(key)!.expires;
    this.data.set(key, { value: String(next), expires });
    return next;
  }
}

export class MemoryBriefEvents implements BriefEvents {
  private readonly listeners = new Map<string, Set<() => void>>();
  async publish(briefId: string) {
    for (const fn of this.listeners.get(briefId) ?? []) fn();
  }
  async subscribe(briefId: string, onChange: () => void) {
    const set = this.listeners.get(briefId) ?? new Set();
    this.listeners.set(briefId, set);
    set.add(onChange);
    return async () => {
      set.delete(onChange);
    };
  }
}

/** Collects jobs; tests run them with `drain()` or set `onEnqueue` to run them immediately. */
export class MemoryJobQueue implements JobQueue {
  readonly jobs: JobData[] = [];
  onEnqueue?: (job: JobData) => void;
  async enqueue(job: JobData) {
    this.jobs.push(job);
    this.onEnqueue?.(job);
  }
}

export class MemoryPlaybookStore implements PlaybookStore {
  readonly rows = new Map<string, PlaybookRecord>();
  async create(rec: PlaybookRecord) {
    this.rows.set(rec.id, clone(rec));
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? clone(r) : null;
  }
  async update(id: string, patch: PlaybookPatch) {
    const r = this.rows.get(id);
    if (!r) return null;
    const next = { ...r, ...clone(patch), updatedAt: new Date() };
    this.rows.set(id, next);
    return clone(next);
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
  async deleteOlderThan(cutoff: Date) {
    let n = 0;
    for (const [id, r] of this.rows) {
      if (r.createdAt < cutoff) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }
}

/** Most recently used (or created) first, then newest, then ID: the same order as Postgres. */
export function skillOrder(a: SkillRecord, b: SkillRecord): number {
  const used = (s: SkillRecord) => (s.lastUsedAt ?? s.createdAt).getTime();
  return (
    used(b) - used(a) ||
    b.createdAt.getTime() - a.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export class MemorySkillStore implements SkillStore {
  readonly rows = new Map<string, SkillRecord>();
  async create(rec: SkillRecord, limit: number) {
    const mine = [...this.rows.values()].filter((r) => r.userId === rec.userId).length;
    if (mine >= limit) return false;
    this.rows.set(rec.id, clone(rec));
    return true;
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? clone(r) : null;
  }
  async listByUser(userId: string) {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId)
      .sort(skillOrder)
      .map((r) => clone(r));
  }
  async update(id: string, patch: SkillPatch) {
    const r = this.rows.get(id);
    if (!r) return null;
    const next = { ...r, ...clone(patch), updatedAt: new Date() };
    this.rows.set(id, next);
    return clone(next);
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
}
