import type {
  AnalyzedRange,
  ApiError,
  Breakdown,
  BriefStage,
  BriefStatus,
  Detail,
  Pass2Output,
  TargetFormat,
  Warning,
} from "@match-cut/core";

/** Video facts kept on a brief. Null when the precheck was skipped. */
export interface BriefVideo {
  title: string;
  channel: string;
  durationSeconds: number;
  embeddable: boolean;
}

export interface BriefMeta {
  /** Pass 1 model. */
  model: string | null;
  pass2Model: string | null;
  cached: boolean;
  timingsMs: Record<string, number>;
  tokens: Record<string, number>;
  pass1Cached?: boolean;
  pass2Cached?: boolean;
  /** Pass 1 needed the repair call. */
  repairUsed?: boolean;
  /** A fallback model produced the breakdown; it was not cached. */
  fallbackUsed?: boolean;
  /** Internal: why the last run failed or went partial. Not returned by the API. */
  lastErrorCode?: string;
  /** PRD: every failed job keeps its error code, upstream status, finish reason and attempts. */
  failure?: {
    code: string;
    upstreamStatus?: number;
    finishReason?: string;
    attempts?: number;
    models?: string[];
  };
  /** Failed upstream attempts across this brief's runs (model, code, HTTP status, finish reason). */
  upstreamFailures?: { model: string; code: string; status?: number; finishReason?: string }[];
  /** Estimated cost of this brief's model calls, USD. */
  costUsd?: number;
}

/** A brief as stored. Internal fields (goal, spoken lines, cache keys) never leave the backend. */
export interface BriefRecord {
  id: string;
  userId: string;
  orgId: string;
  status: BriefStatus;
  stage: BriefStage | null;
  videoId: string;
  video: BriefVideo | null;
  range: AnalyzedRange | null;
  detail: Detail;
  goal: string;
  targetFormat: TargetFormat;
  targetLengthSeconds: number | null;
  outputLanguage: string;
  forceRefresh: boolean;
  breakdown: Breakdown | null;
  spokenLines: string[] | null;
  prompt: Pass2Output | null;
  warnings: Warning[];
  error: ApiError | null;
  meta: BriefMeta;
  createdAt: Date;
  updatedAt: Date;
}

export type BriefPatch = Partial<Omit<BriefRecord, "id" | "userId" | "orgId" | "createdAt">>;

export interface BriefStore {
  create(rec: BriefRecord): Promise<void>;
  get(id: string): Promise<BriefRecord | null>;
  update(id: string, patch: BriefPatch): Promise<BriefRecord | null>;
  delete(id: string): Promise<void>;
  /** Retention: deletes briefs created before `cutoff`. Returns how many. */
  deleteOlderThan(cutoff: Date): Promise<number>;
  /** Ops: briefs updated at or after `since`. */
  listUpdatedSince(since: Date): Promise<BriefRecord[]>;
}

/** Small key-value store with TTLs: cache layers, idempotency keys, in-flight jobs. */
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Sets only if absent. Returns true when this call set it. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Adds `by` (may be fractional or negative) and returns the new value; sets the TTL on create. */
  incrBy(key: string, by: number, ttlSeconds: number): Promise<number>;
}

/** Stage and status changes for one brief, fanned out to SSE listeners on any API instance. */
export interface BriefEvents {
  publish(briefId: string): Promise<void>;
  subscribe(briefId: string, onChange: () => void): Promise<() => Promise<void>>;
}

export type JobKind = "analyze" | "regenerate";
export interface JobData {
  briefId: string;
  kind: JobKind;
}

export interface JobQueue {
  enqueue(job: JobData): Promise<void>;
}
