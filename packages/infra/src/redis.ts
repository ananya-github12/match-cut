import { BRIEF_QUEUE, PLAYBOOK_QUEUE } from "@match-cut/core";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type {
  BriefEvents,
  JobData,
  JobQueue,
  KV,
  PlaybookJobData,
  PlaybookJobQueue,
} from "./types.js";

export class RedisKV implements KV {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "mc:",
  ) {}
  get(key: string) {
    return this.redis.get(this.prefix + key);
  }
  async set(key: string, value: string, ttlSeconds: number) {
    await this.redis.set(this.prefix + key, value, "EX", ttlSeconds);
  }
  async setIfAbsent(key: string, value: string, ttlSeconds: number) {
    return (await this.redis.set(this.prefix + key, value, "EX", ttlSeconds, "NX")) === "OK";
  }
  async del(key: string) {
    await this.redis.del(this.prefix + key);
  }
  async incrBy(key: string, by: number, ttlSeconds: number) {
    const k = this.prefix + key;
    const [[, value]] = (await this.redis
      .multi()
      .incrbyfloat(k, by)
      .expire(k, ttlSeconds, "NX")
      .exec()) as [[unknown, string]];
    return Number(value);
  }
}

/** Pub/sub fan-out. Needs its own subscriber connection, as Redis requires. */
export class RedisBriefEvents implements BriefEvents {
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly channel: string;

  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
    prefix = "mc:",
  ) {
    this.channel = `${prefix}brief:`;
    sub.on("message", (channel: string) => {
      if (!channel.startsWith(this.channel)) return;
      const id = channel.slice(this.channel.length);
      for (const fn of this.listeners.get(id) ?? []) fn();
    });
  }

  async publish(briefId: string) {
    await this.pub.publish(`${this.channel}${briefId}`, "changed");
  }

  async subscribe(briefId: string, onChange: () => void) {
    let set = this.listeners.get(briefId);
    if (!set) {
      set = new Set();
      this.listeners.set(briefId, set);
      await this.sub.subscribe(`${this.channel}${briefId}`);
    }
    set.add(onChange);
    return async () => {
      set.delete(onChange);
      if (set.size === 0) {
        this.listeners.delete(briefId);
        await this.sub.unsubscribe(`${this.channel}${briefId}`);
      }
    };
  }
}

export class BullJobQueue implements JobQueue {
  readonly queue: Queue<JobData>;
  constructor(connection: Redis, prefix = "bull") {
    this.queue = new Queue<JobData>(BRIEF_QUEUE, { connection, prefix });
  }
  async enqueue(job: JobData) {
    // With Redis down, BullMQ would wait forever; fail fast so the API can fall back.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("queue unavailable (timeout)")), 2000);
    });
    try {
      await Promise.race([this.add(job), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async add(job: JobData) {
    await this.queue.add(job.kind, job, {
      // Retries live in the pipeline (M5); BullMQ runs each job once.
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
  }
}

/** Producer for playbook jobs (PLAYBOOK_QUEUE). One job per playbook: the playbook ID is the job ID. */
export class BullPlaybookQueue implements PlaybookJobQueue {
  readonly queue: Queue<PlaybookJobData>;
  constructor(connection: Redis, prefix = "bull") {
    this.queue = new Queue<PlaybookJobData>(PLAYBOOK_QUEUE, { connection, prefix });
  }
  async enqueue(job: PlaybookJobData) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("queue unavailable (timeout)")), 2000);
    });
    try {
      await Promise.race([
        this.queue.add("playbook", job, {
          jobId: job.playbookId,
          // Retries live in the pipeline; a crashed job is restarted once by stalled handling.
          attempts: 1,
          removeOnComplete: 1000,
          removeOnFail: 1000,
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
