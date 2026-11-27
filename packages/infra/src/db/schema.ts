import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const briefs = pgTable(
  "briefs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    status: text("status").notNull(),
    stage: text("stage"),
    videoId: text("video_id").notNull(),
    video: jsonb("video"),
    range: jsonb("analyzed_range"),
    detail: text("detail").notNull(),
    // Encryption at rest lands in M5 (PRD: security, privacy and compliance).
    goal: text("goal").notNull(),
    targetFormat: text("target_format").notNull(),
    targetLengthSeconds: integer("target_length_seconds"),
    outputLanguage: text("output_language").notNull(),
    forceRefresh: boolean("force_refresh").notNull().default(false),
    breakdown: jsonb("breakdown"),
    spokenLines: jsonb("spoken_lines_internal"),
    prompt: jsonb("prompt"),
    warnings: jsonb("warnings").notNull().default([]),
    error: jsonb("error"),
    meta: jsonb("meta").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("briefs_user_created_idx").on(t.userId, t.createdAt),
    // Ops signals scan recently updated briefs.
    index("briefs_updated_at_idx").on(t.updatedAt),
  ],
);

/** PRD-playbooks.md, Feature 3. Rows hold public YouTube stats, so retention deletes them. */
export const playbooks = pgTable(
  "playbooks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    status: text("status").notNull(),
    stage: text("stage"),
    progress: jsonb("progress"),
    // The parsed channel reference; the raw input is never stored.
    source: jsonb("source").notNull(),
    settings: jsonb("settings").notNull(),
    forceRefresh: boolean("force_refresh").notNull().default(false),
    channel: jsonb("channel"),
    // "window" is a reserved word in SQL.
    window: jsonb("scoring_window"),
    baseline: jsonb("baseline"),
    videos: jsonb("videos").notNull().default([]),
    comparison: jsonb("comparison"),
    content: jsonb("content"),
    spokenLines: jsonb("spoken_lines_internal"),
    warnings: jsonb("warnings").notNull().default([]),
    error: jsonb("error"),
    meta: jsonb("meta").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("playbooks_user_created_idx").on(t.userId, t.createdAt),
    index("playbooks_created_at_idx").on(t.createdAt),
  ],
);

/** PRD-playbooks.md, Feature 4. A snapshot of the recipe, so a skill outlives its source. */
export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    // User-written text: encrypted at rest, like goals.
    name: text("name").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceTitle: text("source_title"),
    snapshot: jsonb("snapshot").notNull(),
    versions: jsonb("versions").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("skills_user_created_idx").on(t.userId, t.createdAt)],
);
