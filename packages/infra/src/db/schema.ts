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
