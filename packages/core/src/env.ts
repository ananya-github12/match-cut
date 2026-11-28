import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PROVIDER: z.enum(["gemini", "mock"]).default("mock"),
    GEMINI_API_KEY: optionalString,
    YOUTUBE_DATA_API_KEY: optionalString,
    GEMINI_MODEL_STANDARD: optionalString,
    GEMINI_MODEL_DEEP: optionalString,
    GEMINI_MODEL_FALLBACK: optionalString,
    DATABASE_URL: z.string().url().default("postgres://matchcut:matchcut@localhost:5432/matchcut"),
    REDIS_URL: z.string().url().default("redis://localhost:6379"),
    /** Namespace for every Redis key, channel and queue, so test runs don't touch dev data. */
    REDIS_NAMESPACE: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .default("mc"),
    DEV_API_TOKEN: z.string().trim().min(1, "DEV_API_TOKEN must be set (any non-empty string)"),
    DAILY_SPEND_CAP_USD: z.coerce.number().positive().default(5),
    API_PORT: z.coerce.number().int().positive().default(4000),
    /** Region the server is treated as serving from, for region-blocked videos (ISO 3166-1). */
    YOUTUBE_REGION: z
      .string()
      .regex(/^[A-Za-z]{2}$/, "YOUTUBE_REGION must be a 2-letter country code")
      .transform((v) => v.toUpperCase())
      .default("US"),
    /** PRD caps, configurable: longest video without a clip, and longest clip. */
    MAX_VIDEO_SECONDS: z.coerce.number().int().positive().default(1200),
    MAX_CLIP_SECONDS: z.coerce.number().int().positive().default(600),
    /** Retry timing for Gemini calls. PRD default: 1 s, then 3 s; retry the same model once. */
    GEMINI_RETRY_BACKOFF_MS: z
      .string()
      .regex(/^\d+(,\d+)*$/, "comma-separated milliseconds, e.g. 1000,3000")
      .default("1000,3000"),
    GEMINI_RETRY_SAME_MODEL: z.coerce.number().int().min(0).max(5).default(1),
    /** PRD job budget: failed upstream attempts and wall-clock seconds, across both passes. */
    JOB_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(0).default(4),
    JOB_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(240),
    /** Jobs waiting longer than this fail with CAPACITY_EXHAUSTED (PRD: queue over 2 minutes). */
    QUEUE_MAX_WAIT_SECONDS: z.coerce.number().int().positive().default(120),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(8),
    /** PRD rate limits (proposed values). */
    RATE_USER_PER_HOUR: z.coerce.number().int().positive().default(20),
    RATE_USER_PER_DAY: z.coerce.number().int().positive().default(100),
    RATE_REGENERATE_PER_HOUR: z.coerce.number().int().positive().default(60),
    RATE_ORG_PER_DAY: z.coerce.number().int().positive().default(1000),
    /** PRD-playbooks.md, limits (proposed): 5 playbooks per user per day. */
    RATE_PLAYBOOKS_PER_DAY: z.coerce.number().int().positive().default(5),
    /**
     * Playbooks per org per day (drafted in M10; not in the PRD). A playbook is about 22 model
     * calls, and the per-user limit alone resets with a new user ID.
     */
    RATE_ORG_PLAYBOOKS_PER_DAY: z.coerce.number().int().positive().default(50),
    /** AES-256-GCM key for goal text at rest, base64 of 32 bytes. Required in production. */
    GOAL_ENCRYPTION_KEY: optionalString,
    /** Comma-separated previous keys, still accepted for reading after a rotation. */
    GOAL_ENCRYPTION_KEY_PREVIOUS: optionalString,
    /**
     * Video lookup (precheck and previews): "auto" follows PROVIDER; "youtube" uses the real
     * YouTube Data API even with PROVIDER=mock (real previews and player, mock analysis).
     */
    VIDEO_LOOKUP: z.enum(["auto", "youtube", "mock"]).default("auto"),
    /** Mock mode only: simulated model latency, so progress stages are visible. */
    MOCK_WATCH_DELAY_MS: z.coerce.number().int().min(0).default(4000),
    MOCK_WRITE_DELAY_MS: z.coerce.number().int().min(0).default(2000),
    /** Days to keep briefs (PRD: 90). */
    BRIEF_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
    /**
     * Days to keep playbooks, which hold public YouTube statistics (PRD-playbooks.md: 30 days is
     * the working assumption until the YouTube API policy's limit is confirmed).
     */
    PLAYBOOK_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    /** Whole-playbook time limit: up to 10 videos watched, 3 at a time, then two text calls. */
    PLAYBOOK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
    /** Playbook jobs one worker runs at once (each watches up to 3 videos in parallel). */
    PLAYBOOK_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
    /** PRD-playbooks.md: at most 3 concurrent pass 1 calls per playbook. */
    PLAYBOOK_WATCH_CONCURRENCY: z.coerce.number().int().min(1).max(3).default(3),
    /**
     * Match Cut MCP server (/mcp): comma-separated API keys, each at least 24 characters.
     * Each key is its own user. Empty: the MCP server is off.
     */
    MCP_API_KEYS: optionalString,
    /** Browser origin allowed to call the API (CORS). */
    WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  })
  .superRefine((env, ctx) => {
    if (env.GOAL_ENCRYPTION_KEY && Buffer.from(env.GOAL_ENCRYPTION_KEY, "base64").length !== 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GOAL_ENCRYPTION_KEY"],
        message: "GOAL_ENCRYPTION_KEY must be base64 of 32 bytes (openssl rand -base64 32)",
      });
    }
    if (env.NODE_ENV === "production" && !env.GOAL_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GOAL_ENCRYPTION_KEY"],
        message: "GOAL_ENCRYPTION_KEY is required in production",
      });
    }
    if (env.VIDEO_LOOKUP === "youtube" && !env.YOUTUBE_DATA_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["YOUTUBE_DATA_API_KEY"],
        message: "YOUTUBE_DATA_API_KEY is required when VIDEO_LOOKUP=youtube",
      });
    }
    for (const key of mcpApiKeys(env)) {
      if (key.length < 24 || !/^[A-Za-z0-9_-]+$/.test(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["MCP_API_KEYS"],
          message:
            "MCP_API_KEYS: each key needs 24+ characters of letters, digits, - or _ (openssl rand -hex 24)",
        });
        break;
      }
    }
    if (env.PROVIDER !== "gemini") return;
    const required = [
      "GEMINI_API_KEY",
      "YOUTUBE_DATA_API_KEY",
      "GEMINI_MODEL_STANDARD",
      "GEMINI_MODEL_DEEP",
      "GEMINI_MODEL_FALLBACK",
    ] as const;
    for (const key of required) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when PROVIDER=gemini`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/** The MCP API keys from MCP_API_KEYS, trimmed, empties dropped. */
export function mcpApiKeys(env: { MCP_API_KEYS?: string }): string[] {
  return (env.MCP_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Validates a plain env object. Throws one readable error listing every problem. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return result.data;
}

/** Finds the nearest .env walking up from `startDir`, stopping at the workspace root. */
function findEnvFile(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

let cached: Env | undefined;

/** Loads .env (real environment variables win), validates it, and caches the result. */
export function loadEnv(): Env {
  if (cached) return cached;
  const file = findEnvFile(process.cwd());
  if (file) process.loadEnvFile(file);
  cached = parseEnv(process.env);
  return cached;
}

export interface ModelNames {
  standard: string;
  deep: string;
  /** Tried in order when the requested model is overloaded. GEMINI_MODEL_FALLBACK, comma-separated. */
  fallbacks: string[];
  /** Pass 2 runs on the Flash tier (PRD), i.e. the standard model. */
  pass2: string;
}

/** Model names from env; fixed placeholder names in mock mode. */
export function modelNames(env: Env): ModelNames {
  if (env.PROVIDER === "mock") {
    return {
      standard: "mock-flash",
      deep: "mock-pro",
      fallbacks: ["mock-fallback"],
      pass2: "mock-flash",
    };
  }
  return {
    standard: env.GEMINI_MODEL_STANDARD!,
    deep: env.GEMINI_MODEL_DEEP!,
    fallbacks: env
      .GEMINI_MODEL_FALLBACK!.split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    pass2: env.GEMINI_MODEL_STANDARD!,
  };
}

/** Whether to use the real YouTube Data API for prechecks and previews. */
export function useYouTubeLookup(env: Env): boolean {
  return (
    env.VIDEO_LOOKUP === "youtube" || (env.VIDEO_LOOKUP === "auto" && env.PROVIDER === "gemini")
  );
}
