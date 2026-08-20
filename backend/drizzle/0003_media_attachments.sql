CREATE TYPE "public"."media_kind" AS ENUM('image', 'video', 'audio');--> statement-breakpoint
CREATE TABLE "media_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploader_id" uuid NOT NULL,
	"kind" "media_kind" NOT NULL,
	"content_type" text NOT NULL,
	"object_key" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"entity_type" text,
	"entity_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"attached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "media_attachments" ADD CONSTRAINT "media_attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_attachments_entity_idx" ON "media_attachments" USING btree ("entity_type","entity_id","sort_order") WHERE "media_attachments"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "media_attachments_drafts_idx" ON "media_attachments" USING btree ("created_at") WHERE "media_attachments"."entity_id" is null and "media_attachments"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "media_attachments_deleted_idx" ON "media_attachments" USING btree ("deleted_at") WHERE "media_attachments"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "media_attachments_uploader_idx" ON "media_attachments" USING btree ("uploader_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_attachments_object_key_idx" ON "media_attachments" USING btree ("object_key");