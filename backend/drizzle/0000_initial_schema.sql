CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'adult', 'teen', 'child', 'guest');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('pending_approval', 'active', 'rejected', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('google', 'apple', 'telegram', 'password');--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('scheduled', 'done', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('household', 'private', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."assigned_via" AS ENUM('rotation', 'manual', 'swap', 'claimed');--> statement-breakpoint
CREATE TYPE "public"."event_source_kind" AS ENUM('manual', 'user_birthday', 'imported_ics');--> statement-breakpoint
CREATE TYPE "public"."rsvp_status" AS ENUM('pending', 'yes', 'no', 'maybe');--> statement-breakpoint
CREATE TYPE "public"."points_reason" AS ENUM('chore_completed', 'covered_for_other', 'on_time_bonus', 'streak_bonus', 'manual_award', 'redeemed', 'penalty', 'swap_bonus');--> statement-breakpoint
CREATE TYPE "public"."rotation_strategy" AS ENUM('round_robin', 'weighted_balance', 'fixed', 'anyone');--> statement-breakpoint
CREATE TYPE "public"."swap_status" AS ENUM('pending', 'accepted', 'declined', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('active', 'reached', 'archived', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."goal_txn_kind" AS ENUM('contribution', 'withdrawal', 'correction', 'interest');--> statement-breakpoint
CREATE TYPE "public"."shopping_item_state" AS ENUM('needed', 'bought', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."post_type" AS ENUM('announcement', 'system');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'scheduled', 'sent', 'failed', 'suppressed', 'read', 'delivered', 'interacted', 'acknowledged');--> statement-breakpoint
CREATE TYPE "public"."escalation_state" AS ENUM('none', 'redelivered', 'channel_fallback', 'person_escalated', 'exhausted');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('push', 'telegram', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."notification_priority" AS ENUM('low', 'normal', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('task_assigned', 'task_due_soon', 'task_overdue', 'task_completed', 'chore_swap_requested', 'chore_swap_answered', 'event_reminder', 'event_created', 'birthday_today', 'goal_contribution', 'goal_milestone_reached', 'goal_reached', 'shopping_urgent_item', 'member_pending_approval', 'member_approved', 'announcement_posted', 'kudos_received', 'weekly_digest', 'system_alert');--> statement-breakpoint
CREATE TYPE "public"."quiet_mode" AS ENUM('defer', 'silence');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"password_hash" text,
	"role" "user_role" DEFAULT 'child' NOT NULL,
	"status" "user_status" DEFAULT 'pending_approval' NOT NULL,
	"permission_grants" text[] DEFAULT '{}'::text[] NOT NULL,
	"permission_denies" text[] DEFAULT '{}'::text[] NOT NULL,
	"birth_date" date,
	"timezone" text,
	"locale" text DEFAULT 'ru-RU' NOT NULL,
	"chore_weight" numeric(4, 2) DEFAULT '1.00' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"color" text,
	"approved_at" timestamp with time zone,
	"approved_by_id" uuid,
	"rejected_reason" text,
	"last_seen_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"family_name" text DEFAULT 'Семья' NOT NULL,
	"timezone" text DEFAULT 'Europe/Moscow' NOT NULL,
	"week_starts_on" integer DEFAULT 1 NOT NULL,
	"currency" text DEFAULT 'RUB' NOT NULL,
	"quiet_hours_start" text DEFAULT '22:00' NOT NULL,
	"quiet_hours_end" text DEFAULT '07:30' NOT NULL,
	"allow_registration" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_settings_singleton_ck" CHECK ("family_settings"."singleton")
);
--> statement-breakpoint
CREATE TABLE "oauth_transactions" (
	"state" text PRIMARY KEY NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier" text,
	"intent" text DEFAULT 'login' NOT NULL,
	"link_user_id" uuid,
	"redirect_after" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"prev_token_id" uuid,
	"generation" integer DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"user_agent" text,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"provider_user_id" text NOT NULL,
	"provider_email" text,
	"provider_email_verified" boolean DEFAULT false NOT NULL,
	"provider_username" text,
	"provider_display_name" text,
	"provider_avatar_url" text,
	"is_private_email" boolean DEFAULT false NOT NULL,
	"raw_profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"occurrence_key" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"starts_local" text NOT NULL,
	"status" "occurrence_status" DEFAULT 'scheduled' NOT NULL,
	"is_exception" boolean DEFAULT false NOT NULL,
	"title_override" text,
	"notes_override" text,
	"points_override" integer,
	"assignee_id" uuid,
	"assigned_via" "assigned_via",
	"completed_by_id" uuid,
	"completed_at" timestamp with time zone,
	"skipped_by_id" uuid,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"visibility" "visibility" DEFAULT 'household' NOT NULL,
	"created_by_id" uuid NOT NULL,
	"rrule" text,
	"dtstart_local" text NOT NULL,
	"timezone" text NOT NULL,
	"rdates_local" text[] DEFAULT '{}'::text[] NOT NULL,
	"exdates_local" text[] DEFAULT '{}'::text[] NOT NULL,
	"series_ends_at" timestamp with time zone,
	"materialized_through" timestamp with time zone,
	"due_offset_minutes" integer DEFAULT 0 NOT NULL,
	"grace_minutes" integer DEFAULT 0 NOT NULL,
	"rotation_id" uuid,
	"default_assignee_id" uuid,
	"points" integer DEFAULT 0 NOT NULL,
	"category" text,
	"auto_cancel_after_days" integer,
	"supersedes_series_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rsvp" "rsvp_status" DEFAULT 'pending' NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"occurrence_key" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"starts_local" text NOT NULL,
	"status" "occurrence_status" DEFAULT 'scheduled' NOT NULL,
	"is_exception" boolean DEFAULT false NOT NULL,
	"title_override" text,
	"description_override" text,
	"location_override" text,
	"is_all_day_override" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"visibility" "visibility" DEFAULT 'household' NOT NULL,
	"created_by_id" uuid NOT NULL,
	"rrule" text,
	"dtstart_local" text NOT NULL,
	"timezone" text NOT NULL,
	"rdates_local" text[] DEFAULT '{}'::text[] NOT NULL,
	"exdates_local" text[] DEFAULT '{}'::text[] NOT NULL,
	"series_ends_at" timestamp with time zone,
	"materialized_through" timestamp with time zone,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"is_all_day" boolean DEFAULT false NOT NULL,
	"reminder_offsets" integer[] DEFAULT '{}'::int[] NOT NULL,
	"color" text,
	"category" text,
	"source_kind" "event_source_kind" DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"supersedes_series_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chore_swaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid,
	"status" "swap_status" DEFAULT 'pending' NOT NULL,
	"message" text,
	"bonus_points" integer DEFAULT 0 NOT NULL,
	"responded_by_id" uuid,
	"responded_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kudos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"occurrence_id" uuid,
	"emoji" text DEFAULT '👏' NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "points_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" "points_reason" NOT NULL,
	"occurrence_id" uuid,
	"awarded_by_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rotation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"weight" numeric(4, 2) DEFAULT '1.00' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"strategy" "rotation_strategy" DEFAULT 'weighted_balance' NOT NULL,
	"balance_window_days" integer DEFAULT 28 NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_blackouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_streaks" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"current" integer DEFAULT 0 NOT NULL,
	"longest" integer DEFAULT 0 NOT NULL,
	"last_resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"title" text NOT NULL,
	"target_amount" bigint NOT NULL,
	"reached_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_milestones_target_positive" CHECK ("goal_milestones"."target_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "goal_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"delta" bigint NOT NULL,
	"kind" "goal_txn_kind" DEFAULT 'contribution' NOT NULL,
	"note" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_transactions_delta_not_zero" CHECK ("goal_transactions"."delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "savings_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"target_amount" bigint NOT NULL,
	"currency" text DEFAULT 'RUB' NOT NULL,
	"deadline" date,
	"image_url" text,
	"color" text,
	"icon" text,
	"status" "goal_status" DEFAULT 'active' NOT NULL,
	"visibility" "visibility" DEFAULT 'household' NOT NULL,
	"owner_id" uuid,
	"created_by_id" uuid NOT NULL,
	"reached_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "savings_goals_target_positive" CHECK ("savings_goals"."target_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"default_category" text,
	"default_unit" text,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"is_favourite" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopping_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"name" text NOT NULL,
	"quantity" numeric(10, 3),
	"unit" text,
	"category" text,
	"note" text,
	"requested_by_id" uuid NOT NULL,
	"state" "shopping_item_state" DEFAULT 'needed' NOT NULL,
	"bought_by_id" uuid,
	"bought_at" timestamp with time zone,
	"is_urgent" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"client_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopping_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"color" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"verb" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"summary" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "poll_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poll_id" uuid NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poll_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question" text NOT NULL,
	"closes_at" timestamp with time zone,
	"allow_multiple" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid,
	"type" "post_type" DEFAULT 'announcement' NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"pinned_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digest_subscriptions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"weekday" integer DEFAULT 0 NOT NULL,
	"time_of_day" text DEFAULT '19:00' NOT NULL,
	"sections" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "notification_type" NOT NULL,
	"after_minutes" integer NOT NULL,
	"escalate_to_role" text,
	"escalate_to_user_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"interacted_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"redelivery_count" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"subscription_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "notification_type" NOT NULL,
	"actor_id" uuid,
	"entity_type" text,
	"entity_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audience" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"priority" "notification_priority" DEFAULT 'normal' NOT NULL,
	"escalation_state" "escalation_state" DEFAULT 'none' NOT NULL,
	"escalated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"channel_push" boolean DEFAULT true NOT NULL,
	"channel_telegram" boolean DEFAULT false NOT NULL,
	"channel_in_app" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"device_label" text,
	"is_standalone" boolean DEFAULT false NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_delivered_at" timestamp with time zone,
	"consecutive_no_ack" integer DEFAULT 0 NOT NULL,
	"unhealthy_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiet_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day_of_week" integer,
	"starts_at" text NOT NULL,
	"ends_at" text NOT NULL,
	"mode" "quiet_mode" DEFAULT 'defer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_links" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"telegram_username" text,
	"can_dm" boolean DEFAULT true NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_transactions" ADD CONSTRAINT "oauth_transactions_link_user_id_users_id_fk" FOREIGN KEY ("link_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_series_id_task_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."task_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_completed_by_id_users_id_fk" FOREIGN KEY ("completed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_skipped_by_id_users_id_fk" FOREIGN KEY ("skipped_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_series" ADD CONSTRAINT "task_series_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_series" ADD CONSTRAINT "task_series_default_assignee_id_users_id_fk" FOREIGN KEY ("default_assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_series" ADD CONSTRAINT "task_series_supersedes_series_id_task_series_id_fk" FOREIGN KEY ("supersedes_series_id") REFERENCES "public"."task_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_occurrence_id_event_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."event_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_occurrences" ADD CONSTRAINT "event_occurrences_series_id_event_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."event_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_series" ADD CONSTRAINT "event_series_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_series" ADD CONSTRAINT "event_series_supersedes_series_id_event_series_id_fk" FOREIGN KEY ("supersedes_series_id") REFERENCES "public"."event_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chore_swaps" ADD CONSTRAINT "chore_swaps_occurrence_id_task_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."task_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chore_swaps" ADD CONSTRAINT "chore_swaps_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chore_swaps" ADD CONSTRAINT "chore_swaps_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chore_swaps" ADD CONSTRAINT "chore_swaps_responded_by_id_users_id_fk" FOREIGN KEY ("responded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kudos" ADD CONSTRAINT "kudos_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kudos" ADD CONSTRAINT "kudos_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kudos" ADD CONSTRAINT "kudos_occurrence_id_task_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."task_occurrences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_occurrence_id_task_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."task_occurrences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_awarded_by_id_users_id_fk" FOREIGN KEY ("awarded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_members" ADD CONSTRAINT "rotation_members_rotation_id_rotations_id_fk" FOREIGN KEY ("rotation_id") REFERENCES "public"."rotations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_members" ADD CONSTRAINT "rotation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blackouts" ADD CONSTRAINT "user_blackouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_streaks" ADD CONSTRAINT "user_streaks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_milestones" ADD CONSTRAINT "goal_milestones_goal_id_savings_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."savings_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_transactions" ADD CONSTRAINT "goal_transactions_goal_id_savings_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."savings_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_transactions" ADD CONSTRAINT "goal_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_transactions" ADD CONSTRAINT "goal_transactions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_items" ADD CONSTRAINT "shopping_items_list_id_shopping_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."shopping_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_items" ADD CONSTRAINT "shopping_items_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_items" ADD CONSTRAINT "shopping_items_bought_by_id_users_id_fk" FOREIGN KEY ("bought_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_lists" ADD CONSTRAINT "shopping_lists_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_option_id_poll_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."poll_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_subscriptions" ADD CONSTRAINT "digest_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_policies" ADD CONSTRAINT "escalation_policies_escalate_to_user_id_users_id_fk" FOREIGN KEY ("escalate_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_intent_id_notification_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."notification_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_subscription_id_push_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiet_hours" ADD CONSTRAINT "quiet_hours_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email")) WHERE "users"."email" is not null;--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_created_at_idx" ON "audit_log" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "family_settings_singleton_uq" ON "family_settings" USING btree ("singleton");--> statement-breakpoint
CREATE INDEX "oauth_transactions_expires_at_idx" ON "oauth_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_transactions_link_user_idx" ON "oauth_transactions" USING btree ("link_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_token_hash_uq" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_live_idx" ON "refresh_tokens" USING btree ("user_id","family_id") WHERE "refresh_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_provider_subject_uq" ON "user_identities" USING btree ("provider","provider_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_user_provider_uq" ON "user_identities" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "task_occurrences_series_key_uq" ON "task_occurrences" USING btree ("series_id","occurrence_key");--> statement-breakpoint
CREATE INDEX "task_occurrences_local_date_idx" ON "task_occurrences" USING btree ("local_date");--> statement-breakpoint
CREATE INDEX "task_occurrences_assignee_due_idx" ON "task_occurrences" USING btree ("assignee_id","due_at") WHERE "task_occurrences"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "task_occurrences_overdue_idx" ON "task_occurrences" USING btree ("due_at") WHERE "task_occurrences"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "task_occurrences_series_starts_idx" ON "task_occurrences" USING btree ("series_id","starts_at");--> statement-breakpoint
CREATE INDEX "task_series_materializer_idx" ON "task_series" USING btree ("materialized_through") WHERE "task_series"."archived_at" is null and "task_series"."rrule" is not null;--> statement-breakpoint
CREATE INDEX "task_series_created_by_idx" ON "task_series" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "task_series_rotation_idx" ON "task_series" USING btree ("rotation_id");--> statement-breakpoint
CREATE INDEX "task_series_supersedes_idx" ON "task_series" USING btree ("supersedes_series_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_attendees_occurrence_user_uq" ON "event_attendees" USING btree ("occurrence_id","user_id");--> statement-breakpoint
CREATE INDEX "event_attendees_user_idx" ON "event_attendees" USING btree ("user_id","rsvp");--> statement-breakpoint
CREATE UNIQUE INDEX "event_occurrences_series_key_uq" ON "event_occurrences" USING btree ("series_id","occurrence_key");--> statement-breakpoint
CREATE INDEX "event_occurrences_local_date_idx" ON "event_occurrences" USING btree ("local_date");--> statement-breakpoint
CREATE INDEX "event_occurrences_starts_idx" ON "event_occurrences" USING btree ("starts_at") WHERE "event_occurrences"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "event_occurrences_series_starts_idx" ON "event_occurrences" USING btree ("series_id","starts_at");--> statement-breakpoint
CREATE INDEX "event_series_materializer_idx" ON "event_series" USING btree ("materialized_through") WHERE "event_series"."archived_at" is null and "event_series"."rrule" is not null;--> statement-breakpoint
CREATE INDEX "event_series_created_by_idx" ON "event_series" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "event_series_supersedes_idx" ON "event_series" USING btree ("supersedes_series_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_series_source_uq" ON "event_series" USING btree ("source_kind","source_ref") WHERE "event_series"."source_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "chore_swaps_one_pending_uq" ON "chore_swaps" USING btree ("occurrence_id") WHERE "chore_swaps"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "chore_swaps_to_user_idx" ON "chore_swaps" USING btree ("to_user_id","status");--> statement-breakpoint
CREATE INDEX "chore_swaps_from_user_idx" ON "chore_swaps" USING btree ("from_user_id","status");--> statement-breakpoint
CREATE INDEX "chore_swaps_occurrence_idx" ON "chore_swaps" USING btree ("occurrence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kudos_from_occurrence_emoji_uq" ON "kudos" USING btree ("from_user_id","occurrence_id","emoji");--> statement-breakpoint
CREATE INDEX "kudos_to_user_idx" ON "kudos" USING btree ("to_user_id","created_at");--> statement-breakpoint
CREATE INDEX "points_ledger_user_created_idx" ON "points_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "points_ledger_award_once_uq" ON "points_ledger" USING btree ("occurrence_id","user_id","reason") WHERE "points_ledger"."occurrence_id" is not null and "points_ledger"."reason" in ('chore_completed', 'on_time_bonus');--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_members_rotation_user_uq" ON "rotation_members" USING btree ("rotation_id","user_id");--> statement-breakpoint
CREATE INDEX "rotation_members_rotation_position_idx" ON "rotation_members" USING btree ("rotation_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "rotations_name_uq" ON "rotations" USING btree ("name");--> statement-breakpoint
CREATE INDEX "user_blackouts_user_range_idx" ON "user_blackouts" USING btree ("user_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "goal_milestones_goal_idx" ON "goal_milestones" USING btree ("goal_id","sort_order");--> statement-breakpoint
CREATE INDEX "goal_transactions_goal_occurred_idx" ON "goal_transactions" USING btree ("goal_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "goal_transactions_user_idx" ON "goal_transactions" USING btree ("user_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "savings_goals_status_idx" ON "savings_goals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "savings_goals_owner_idx" ON "savings_goals" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "savings_goals_active_idx" ON "savings_goals" USING btree ("sort_order","created_at") WHERE "savings_goals"."deleted_at" is null and "savings_goals"."status" = 'active';--> statement-breakpoint
CREATE INDEX "savings_goals_deadline_idx" ON "savings_goals" USING btree ("deadline") WHERE "savings_goals"."deadline" is not null and "savings_goals"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_catalog_name_lower_uq" ON "product_catalog" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "product_catalog_suggest_idx" ON "product_catalog" USING btree ("is_favourite" DESC NULLS LAST,"usage_count" DESC NULLS LAST,"last_used_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shopping_items_list_state_idx" ON "shopping_items" USING btree ("list_id","state");--> statement-breakpoint
CREATE INDEX "shopping_items_active_idx" ON "shopping_items" USING btree ("list_id","is_urgent" DESC NULLS LAST,"sort_order","created_at") WHERE "shopping_items"."state" = 'needed';--> statement-breakpoint
CREATE INDEX "shopping_items_bought_idx" ON "shopping_items" USING btree ("bought_at" DESC NULLS LAST) WHERE "shopping_items"."state" = 'bought';--> statement-breakpoint
CREATE UNIQUE INDEX "shopping_items_client_id_uq" ON "shopping_items" USING btree ("client_id") WHERE "shopping_items"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "shopping_lists_active_idx" ON "shopping_lists" USING btree ("sort_order","name") WHERE "shopping_lists"."is_archived" = false;--> statement-breakpoint
CREATE INDEX "activity_log_created_at_idx" ON "activity_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_log_actor_idx" ON "activity_log" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_log_entity_idx" ON "activity_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "activity_log_verb_idx" ON "activity_log" USING btree ("verb");--> statement-breakpoint
CREATE INDEX "comments_entity_idx" ON "comments" USING btree ("entity_type","entity_id","created_at") WHERE "comments"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "comments_author_idx" ON "comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "poll_options_poll_idx" ON "poll_options" USING btree ("poll_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "poll_votes_unique_idx" ON "poll_votes" USING btree ("poll_id","user_id","option_id");--> statement-breakpoint
CREATE INDEX "poll_votes_option_idx" ON "poll_votes" USING btree ("option_id");--> statement-breakpoint
CREATE INDEX "polls_open_idx" ON "polls" USING btree ("created_at" DESC NULLS LAST) WHERE "polls"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "posts_created_at_idx" ON "posts" USING btree ("created_at" DESC NULLS LAST) WHERE "posts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "posts_pinned_idx" ON "posts" USING btree ("pinned_until" DESC NULLS LAST) WHERE "posts"."pinned_until" is not null and "posts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "posts_author_idx" ON "posts" USING btree ("author_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reactions_unique_idx" ON "reactions" USING btree ("entity_type","entity_id","user_id","emoji");--> statement-breakpoint
CREATE INDEX "reactions_entity_idx" ON "reactions" USING btree ("entity_type","entity_id","emoji");--> statement-breakpoint
CREATE INDEX "escalation_policies_type_idx" ON "escalation_policies" USING btree ("type") WHERE "escalation_policies"."enabled";--> statement-breakpoint
CREATE INDEX "notification_deliveries_inbox_idx" ON "notification_deliveries" USING btree ("user_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries" USING btree ("scheduled_for") WHERE "notification_deliveries"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "notification_deliveries_intent_idx" ON "notification_deliveries" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_unconfirmed_idx" ON "notification_deliveries" USING btree ("sent_at") WHERE "notification_deliveries"."status" = 'sent';--> statement-breakpoint
CREATE INDEX "notification_deliveries_subscription_idx" ON "notification_deliveries" USING btree ("subscription_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "notification_intents_dedupe_uq" ON "notification_intents" USING btree ("dedupe_key") WHERE "notification_intents"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "notification_intents_type_created_idx" ON "notification_intents" USING btree ("type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_intents_entity_idx" ON "notification_intents" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_type_uq" ON "notification_preferences" USING btree ("user_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_uq" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_live_idx" ON "push_subscriptions" USING btree ("user_id") WHERE "push_subscriptions"."expired_at" is null;--> statement-breakpoint
CREATE INDEX "quiet_hours_user_idx" ON "quiet_hours" USING btree ("user_id");