/**
 * Rate limits and the daily spend cap. PRD: "Backend: performance, cost, caching and limits".
 * Fixed windows in the KV store. Both fail open if the store is down (SafeKV returns 0).
 */
import type { KV } from "./types.js";

/** analyze: a new brief. regenerate: a new prompt (also apply). playbook: a new playbook. */
export type LimitKind = "analyze" | "regenerate" | "playbook";

export interface LimitRule {
  name: string;
  kind: LimitKind;
  scope: "user" | "org";
  limit: number;
  windowSeconds: number;
}

export function defaultRules(c: {
  userPerHour: number;
  userPerDay: number;
  regeneratePerHour: number;
  orgPerDay: number;
  /** PRD-playbooks.md: 5 a day. Omit for no playbook limit. */
  playbooksPerDay?: number;
}): LimitRule[] {
  return [
    {
      name: "user-hour",
      kind: "analyze",
      scope: "user",
      limit: c.userPerHour,
      windowSeconds: 3600,
    },
    { name: "user-day", kind: "analyze", scope: "user", limit: c.userPerDay, windowSeconds: 86400 },
    { name: "org-day", kind: "analyze", scope: "org", limit: c.orgPerDay, windowSeconds: 86400 },
    {
      name: "regen-hour",
      kind: "regenerate",
      scope: "user",
      limit: c.regeneratePerHour,
      windowSeconds: 3600,
    },
    ...(c.playbooksPerDay === undefined
      ? []
      : [
          {
            name: "playbook-day",
            kind: "playbook" as const,
            scope: "user" as const,
            limit: c.playbooksPerDay,
            windowSeconds: 86400,
          },
        ]),
  ];
}

export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number; rule: string };

export interface Who {
  userId: string;
  orgId: string;
}

export class RateLimiter {
  constructor(
    private readonly kv: KV,
    private readonly rules: LimitRule[],
    private readonly now: () => number = Date.now,
  ) {}

  private key(rule: LimitRule, who: Who, at: number) {
    const id = rule.scope === "user" ? who.userId : who.orgId;
    return `rl:${rule.name}:${id}:${Math.floor(at / 1000 / rule.windowSeconds)}`;
  }

  /** Counts one request. Over any limit: the count is undone and the wait is returned. */
  async take(kind: LimitKind, who: Who): Promise<LimitResult> {
    const at = this.now();
    const taken: { key: string; ttl: number }[] = [];
    for (const rule of this.rules.filter((r) => r.kind === kind)) {
      const key = this.key(rule, who, at);
      const count = await this.kv.incrBy(key, 1, rule.windowSeconds);
      taken.push({ key, ttl: rule.windowSeconds });
      if (count > rule.limit) {
        for (const t of taken) await this.kv.incrBy(t.key, -1, t.ttl);
        const windowEnd = (Math.floor(at / 1000 / rule.windowSeconds) + 1) * rule.windowSeconds;
        return {
          ok: false,
          retryAfterSeconds: Math.max(1, Math.ceil(windowEnd - at / 1000)),
          rule: rule.name,
        };
      }
    }
    return { ok: true };
  }

  /** PRD: failed jobs are not billed to user quotas. Gives back a slot taken at `at`. */
  async refund(kind: LimitKind, who: Who, at: Date): Promise<void> {
    for (const rule of this.rules.filter((r) => r.kind === kind)) {
      const key = this.key(rule, who, at.getTime());
      if ((await this.kv.get(key)) !== null) await this.kv.incrBy(key, -1, rule.windowSeconds);
    }
  }
}

export interface SpendOptions {
  capUsd: number;
  /** PRD: alert at 70%. */
  alertFraction?: number;
  now?: () => number;
  alert?: (msg: string) => void;
}

export class SpendTracker {
  constructor(
    private readonly kv: KV,
    private readonly opts: SpendOptions,
  ) {}

  private day() {
    return new Date((this.opts.now ?? Date.now)()).toISOString().slice(0, 10);
  }

  async today(): Promise<number> {
    return Number((await this.kv.get(`spend:${this.day()}`)) ?? 0);
  }

  async overCap(): Promise<boolean> {
    return (await this.today()) >= this.opts.capUsd;
  }

  async add(usd: number): Promise<void> {
    if (usd <= 0) return;
    const day = this.day();
    const total = await this.kv.incrBy(`spend:${day}`, usd, 2 * 86400);
    if (total < this.opts.capUsd * (this.opts.alertFraction ?? 0.7)) return;
    // Alert once per day per level.
    const level = total >= this.opts.capUsd ? "cap" : "warn";
    if (!(await this.kv.setIfAbsent(`spend-alert:${day}:${level}`, "1", 2 * 86400))) return;
    const alert = this.opts.alert ?? ((m: string) => console.warn(m));
    alert(
      level === "cap"
        ? `[alert] daily spend cap reached: $${total.toFixed(2)} of $${this.opts.capUsd}; new jobs are refused`
        : `[alert] daily spend at ${Math.round((total / this.opts.capUsd) * 100)}% of the $${this.opts.capUsd} cap`,
    );
  }
}
