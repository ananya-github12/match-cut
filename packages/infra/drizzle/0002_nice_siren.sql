CREATE TABLE "playbooks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"status" text NOT NULL,
	"stage" text,
	"progress" jsonb,
	"source" jsonb NOT NULL,
	"settings" jsonb NOT NULL,
	"force_refresh" boolean DEFAULT false NOT NULL,
	"channel_id" text,
	"channel" jsonb,
	"scoring_window" jsonb,
	"baseline" jsonb,
	"videos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comparison" jsonb,
	"content" jsonb,
	"spoken_lines_internal" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" jsonb,
	"meta" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"source_title" text,
	"snapshot" jsonb NOT NULL,
	"versions" jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "playbooks_user_created_idx" ON "playbooks" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "playbooks_created_at_idx" ON "playbooks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "playbooks_channel_created_idx" ON "playbooks" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "skills_user_created_idx" ON "skills" USING btree ("user_id","created_at");