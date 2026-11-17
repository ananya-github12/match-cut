CREATE TABLE "briefs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"status" text NOT NULL,
	"stage" text,
	"video_id" text NOT NULL,
	"video" jsonb,
	"analyzed_range" jsonb,
	"detail" text NOT NULL,
	"goal" text NOT NULL,
	"target_format" text NOT NULL,
	"target_length_seconds" integer,
	"output_language" text NOT NULL,
	"force_refresh" boolean DEFAULT false NOT NULL,
	"breakdown" jsonb,
	"spoken_lines_internal" jsonb,
	"prompt" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" jsonb,
	"meta" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "briefs_user_created_idx" ON "briefs" USING btree ("user_id","created_at");