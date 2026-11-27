import type { BriefStatus, PlaybookStage } from "@match-cut/core";
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { PlaybookRecord, SkillSnapshot, SkillSource } from "../types.js";

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
    status: text("status").$type<BriefStatus>().notNull(),
    stage: text("stage").$type<PlaybookStage>(),
    progress: jsonb("progress").$type<PlaybookRecord["progress"]>(),
    // The parsed channel reference; the raw input is never stored.
    source: jsonb("source").$type<PlaybookRecord["source"]>().notNull(),
    settings: jsonb("settings").$type<PlaybookRecord["settings"]>().notNull(),
    forceRefresh: boolean("force_refresh").notNull().default(false),
    // Copied from channel.id by the store, for the 24-hour repeat lookup.
    channelId: text("channel_id"),
    channel: jsonb("channel").$type<PlaybookRecord["channel"]>(),
    // "window" is a reserved word in SQL.
    window: jsonb("scoring_window").$type<PlaybookRecord["window"]>(),
    baseline: jsonb("baseline").$type<PlaybookRecord["baseline"]>(),
    notEnoughData: jsonb("not_enough_data").$type<PlaybookRecord["notEnoughData"]>(),
    videos: jsonb("videos").$type<PlaybookRecord["videos"]>().notNull().default([]),
    comparison: jsonb("comparison").$type<PlaybookRecord["comparison"]>(),
    content: jsonb("content").$type<PlaybookRecord["content"]>(),
    spokenLines: jsonb("spoken_lines_internal").$type<string[]>(),
    warnings: jsonb("warnings").$type<PlaybookRecord["warnings"]>().notNull().default([]),
    error: jsonb("error").$type<PlaybookRecord["error"]>(),
    meta: jsonb("meta").$type<PlaybookRecord["meta"]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("playbooks_user_created_idx").on(t.userId, t.createdAt),
    index("playbooks_created_at_idx").on(t.createdAt),
    index("playbooks_channel_created_idx").on(t.channelId, t.createdAt),
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
    sourceType: text("source_type").$type<SkillSource["type"]>().notNull(),
    sourceId: text("source_id").notNull(),
    sourceTitle: text("source_title"),
    snapshot: jsonb("snapshot").$type<SkillSnapshot>().notNull(),
    versions: jsonb("versions").$type<Record<string, string>>().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("skills_user_created_idx").on(t.userId, t.createdAt)],
);
