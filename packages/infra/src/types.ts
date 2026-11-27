import type {
  AnalyzedRange,
  ApiError,
  Breakdown,
  BriefStage,
  BriefStatus,
  CandidateRule,
  ChannelRef,
  Detail,
  FeatureCount,
  FeatureRow,
  HouseStyle,
  Pass2Output,
  PlaybookContent,
  PlaybookRule,
  PlaybookStage,
  PlaybookWarning,
  ScoringWindow,
  TargetFormat,
  VideoGroup,
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

// ---------- Playbooks (PRD-playbooks.md, Feature 3) ----------

export interface PlaybookSettings {
  windowDays: number;
  maxVideos: number;
  outlierThreshold: number;
}

export interface PlaybookChannel {
  id: string;
  title: string;
  handle: string | null;
  /** Rounded down by YouTube; null when hidden. */
  subscriberCount: number | null;
  subscriberCountHidden: boolean;
}

/** One upload in the window, with its public stats (deleted with the playbook, see retention). */
export interface PlaybookVideo {
  id: string;
  title: string;
  publishedAt: string;
  durationSeconds: number;
  views: number;
  likes: number | null;
  comments: number | null;
  outlierScore: number | null;
  engagementRate: number | null;
  group: VideoGroup;
  /** The brief holding a compared video's breakdown, when one was saved. */
  briefId: string | null;
}

/** Everything the comparison computed: the evidence table behind the rules, kept for evals. */
export interface PlaybookComparison {
  table: FeatureCount[];
  rules: CandidateRule[];
  houseStyle: HouseStyle[];
  outlierTopics: string[];
  /** Each compared video's feature row. */
  features: { videoId: string; group: "outlier" | "typical"; features: FeatureRow }[];
}

/** The written playbook. Its warnings are merged into PlaybookRecord.warnings. */
export type PlaybookStoredContent = Omit<PlaybookContent, "warnings">;

export interface PlaybookMeta {
  /** Model per step: pass1, features, playbook. */
  models: Record<string, string>;
  /** Versions behind this playbook (pass 1, schema, features, comparison, playbook). */
  versions: Record<string, string>;
  cached: boolean;
  timingsMs: Record<string, number>;
  tokens: Record<string, number>;
  costUsd?: number;
  /** Feature answers that had no real quote and became "unknown". */
  ungrounded?: number;
  /** The writer's output needed the repair call / still needed fallbacks after it. */
  repairUsed?: boolean;
  fallbacksUsed?: boolean;
  lastErrorCode?: string;
  failure?: BriefMeta["failure"];
  upstreamFailures?: BriefMeta["upstreamFailures"];
}

/** A playbook as stored. Spoken lines and the parsed source stay internal. */
export interface PlaybookRecord {
  id: string;
  userId: string;
  orgId: string;
  status: BriefStatus;
  stage: PlaybookStage | null;
  progress: { done: number; total: number } | null;
  /** The parsed channel input; the raw text the user typed is never stored. */
  source: ChannelRef;
  settings: PlaybookSettings;
  forceRefresh: boolean;
  channel: PlaybookChannel | null;
  window: ScoringWindow | null;
  baseline: { medianViews: number; medianEngagementRate: number | null } | null;
  videos: PlaybookVideo[];
  comparison: PlaybookComparison | null;
  content: PlaybookStoredContent | null;
  /** Internal only: the breakouts' spoken lines, for copy checks when a recipe is applied. */
  spokenLines: string[] | null;
  warnings: PlaybookWarning[];
  error: ApiError | null;
  meta: PlaybookMeta;
  createdAt: Date;
  updatedAt: Date;
}

export type PlaybookPatch = Partial<Omit<PlaybookRecord, "id" | "userId" | "orgId" | "createdAt">>;

export interface PlaybookUpdateOptions {
  /**
   * Apply the patch only while the playbook has one of these statuses, so the worker's final
   * write can't undo a cancel that landed first. Returns null when the status didn't match.
   */
  onlyIfStatus?: readonly BriefStatus[];
}

export interface PlaybookStore {
  /** Throws if the ID exists. */
  create(rec: PlaybookRecord): Promise<void>;
  /** By ID only: checking the owner is the API's job. */
  get(id: string): Promise<PlaybookRecord | null>;
  /** Keys whose value is undefined are left unchanged; null clears. */
  update(
    id: string,
    patch: PlaybookPatch,
    opts?: PlaybookUpdateOptions,
  ): Promise<PlaybookRecord | null>;
  delete(id: string): Promise<void>;
  /** Retention: YouTube statistics are kept no longer than allowed. Returns how many. */
  deleteOlderThan(cutoff: Date): Promise<number>;
  /**
   * The user's newest succeeded playbook for this channel and these settings made at or after
   * `since` (PRD: a repeat request within 24 h returns it with 200). Null if none.
   */
  findRecent(q: {
    userId: string;
    channelId: string;
    settings: PlaybookSettings;
    since: Date;
  }): Promise<PlaybookRecord | null>;
  /** Playbooks the user started at or after `since` (PRD limit: 5 a day). */
  countByUserSince(userId: string, since: Date): Promise<number>;
}

// ---------- Skills (PRD-playbooks.md, Feature 4) ----------

export type SkillSource = { type: "brief"; id: string } | { type: "playbook"; id: string };

/**
 * What apply needs, copied at save time so a skill keeps working after its brief or playbook is
 * deleted and caches expire. No view, like or comment counts; the rules keep their evidence
 * counts (how many compared videos had each edit choice). No speech either: apply's copy check
 * uses one-way fingerprints of the source's spoken lines (spokenFingerprints in core).
 */
export type SkillSnapshot =
  | {
      type: "brief";
      /** When the source brief was made (ISO 8601). */
      generatedAt: string;
      videoId: string;
      videoTitle: string | null;
      breakdown: Breakdown;
      /** Internal only. */
      spokenFingerprints: string[];
    }
  | {
      type: "playbook";
      generatedAt: string;
      channel: { id: string; title: string; handle: string | null };
      /** The playbook's settings, for "Refresh from channel". */
      settings: PlaybookSettings;
      window: { from: string; to: string } | null;
      rules: PlaybookRule[];
      houseStyle: string;
      notExplained: string[];
      recipePromptTemplate: string | null;
      /** The playbook's caveats travel with its rules. */
      warnings: PlaybookWarning[];
      /** Internal only. */
      spokenFingerprints: string[];
    };

export interface SkillRecord {
  id: string;
  userId: string;
  orgId: string;
  /** User-written; encrypted at rest like goals. */
  name: string;
  source: SkillSource;
  /** The reference video's or channel's title, for the skills list. */
  sourceTitle: string | null;
  snapshot: SkillSnapshot;
  versions: Record<string, string>;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SkillPatch = Partial<
  Pick<SkillRecord, "name" | "snapshot" | "versions" | "sourceTitle">
>;

export interface SkillStore {
  /**
   * Saves the skill unless the user already has `limit` skills (PRD: 50). Returns false at the
   * limit. Atomic per user, so two concurrent saves can't both take the last slot.
   */
  create(rec: SkillRecord, limit: number): Promise<boolean>;
  get(id: string): Promise<SkillRecord | null>;
  /** The user's skills, most recently used (or created) first. */
  listByUser(userId: string): Promise<SkillRecord[]>;
  /** Keys whose value is undefined are left unchanged. Bumps updatedAt. */
  update(id: string, patch: SkillPatch): Promise<SkillRecord | null>;
  /** Records an apply: sets lastUsedAt only (not an edit, so updatedAt stays). */
  markUsed(id: string, at: Date): Promise<void>;
  delete(id: string): Promise<void>;
}
