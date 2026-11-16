// One-shot schema migration runner. Vercel marks DATABASE_URL "Sensitive"
// (unreadable from the CLI), so DDL runs here, where the real env lives.
// Guarded by MIGRATE_TOKEN; idempotent (IF NOT EXISTS everywhere; the one
// primary-key swap on invoices checks the catalog before it acts).
import { neon } from "@neondatabase/serverless";
import { hasMigrateToken } from "@/lib/operator-token";

const DDL = [
  `CREATE TABLE IF NOT EXISTS "clients" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "email" text NOT NULL,
    "name" text,
    "company" text,
    "phone" text,
    "stripe_customer_id" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "clients_email_unique" UNIQUE("email")
  )`,
  `CREATE TABLE IF NOT EXISTS "listings" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "client_id" uuid NOT NULL,
    "address" text NOT NULL,
    "slug" text NOT NULL,
    "shoot_date" timestamp,
    "cover_key" text,
    "download_locked" boolean DEFAULT true NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "listings_slug_unique" UNIQUE("slug")
  )`,
  `CREATE TABLE IF NOT EXISTS "media" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "listing_id" uuid NOT NULL,
    "kind" text NOT NULL,
    "r2_key" text NOT NULL,
    "filename" text NOT NULL,
    "bytes" integer,
    "sort" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "invoices" (
    "stripe_invoice_id" text PRIMARY KEY NOT NULL,
    "listing_id" uuid,
    "client_email" text,
    "property_address" text,
    "status" text NOT NULL,
    "amount_due" integer,
    "hosted_invoice_url" text,
    "updated_at" timestamp DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "downloads" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "media_id" uuid NOT NULL,
    "listing_id" uuid NOT NULL,
    "client_email" text NOT NULL,
    "at" timestamp DEFAULT now() NOT NULL
  )`,
  `DO $$ BEGIN
    ALTER TABLE "listings" ADD CONSTRAINT "listings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "clients"("id");
  EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `DO $$ BEGIN
    ALTER TABLE "media" ADD CONSTRAINT "media_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "listings"("id");
  EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `DO $$ BEGIN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "listings"("id");
  EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `DO $$ BEGIN
    ALTER TABLE "downloads" ADD CONSTRAINT "downloads_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "media"("id");
  EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `DO $$ BEGIN
    ALTER TABLE "downloads" ADD CONSTRAINT "downloads_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "listings"("id");
  EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "team" text`,
  `ALTER TABLE "downloads" ADD COLUMN IF NOT EXISTS "filename" text`,
  `ALTER TABLE "downloads" ALTER COLUMN "media_id" DROP NOT NULL`,
  `DO $$ BEGIN
    ALTER TABLE "downloads" DROP CONSTRAINT IF EXISTS "downloads_media_id_media_id_fk";
    ALTER TABLE "downloads" ADD CONSTRAINT "downloads_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE SET NULL;
  EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "share_token" text`,
  `ALTER TABLE "listings" ALTER COLUMN "share_token" SET DEFAULT replace(gen_random_uuid()::text, '-', '')`,
  `UPDATE "listings" SET "share_token" = replace(gen_random_uuid()::text, '-', '') WHERE "share_token" IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "listings_share_token_idx" ON "listings"("share_token")`,
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "revision" boolean NOT NULL DEFAULT false`,
  `ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "delivery_email_at" timestamp`,
  `ALTER TABLE "media" ALTER COLUMN "bytes" TYPE bigint`,
  `ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "approved_at" timestamp`,
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "section" text`,
  `ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "links" text`,
  `CREATE TABLE IF NOT EXISTS "revision_requests" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "listing_id" uuid NOT NULL REFERENCES "listings"("id"),
    "client_email" text NOT NULL,
    "notes" text NOT NULL,
    "filenames" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "resolved_at" timestamp
  )`,
  // ---- v1.1 team side (additive only: production and preview share this DB) ----
  `ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "nda" boolean NOT NULL DEFAULT false`,
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "shoot_id" uuid`,
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "qc_state" text NOT NULL DEFAULT 'approved'`,
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "editor_image_id" text`,
  `ALTER TABLE "revision_requests" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'new'`,
  `ALTER TABLE "revision_requests" ADD COLUMN IF NOT EXISTS "resolved_by" text`,
  `UPDATE "revision_requests" SET "status" = 'done' WHERE "resolved_at" IS NOT NULL AND "status" = 'new'`,
  `CREATE TABLE IF NOT EXISTS "shoots" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "listing_id" uuid NOT NULL REFERENCES "listings"("id"),
    "created_by" text NOT NULL,
    "status" text NOT NULL DEFAULT 'draft',
    "options" jsonb,
    "progress" jsonb,
    "autohdr_photoshoot_id" integer,
    "autohdr_job_id" text,
    "file_count" integer NOT NULL DEFAULT 0,
    "photo_count" integer NOT NULL DEFAULT 0,
    "error" text,
    "lease_until" timestamp,
    "step_started_at" timestamp,
    "submitted_at" timestamp,
    "ready_at" timestamp,
    "published_at" timestamp,
    "published_by" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "shoot_files" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "shoot_id" uuid NOT NULL REFERENCES "shoots"("id"),
    "filename" text NOT NULL,
    "r2_key" text NOT NULL,
    "bytes" bigint,
    "content_type" text,
    "kind" text NOT NULL DEFAULT 'raw',
    "autohdr_uploaded_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "activity" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "actor_email" text,
    "action" text NOT NULL,
    "listing_id" uuid,
    "shoot_id" uuid,
    "client_id" uuid,
    "meta" jsonb,
    "created_at" timestamp DEFAULT now() NOT NULL
  )`,
  `DO $$ BEGIN
    ALTER TABLE "media" ADD CONSTRAINT "media_shoot_id_shoots_id_fk" FOREIGN KEY ("shoot_id") REFERENCES "shoots"("id") ON DELETE SET NULL;
  EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `CREATE INDEX IF NOT EXISTS "shoots_status_idx" ON "shoots"("status")`,
  `CREATE INDEX IF NOT EXISTS "shoots_listing_idx" ON "shoots"("listing_id")`,
  `CREATE INDEX IF NOT EXISTS "shoot_files_shoot_idx" ON "shoot_files"("shoot_id")`,
  `CREATE INDEX IF NOT EXISTS "media_shoot_idx" ON "media"("shoot_id")`,
  `CREATE INDEX IF NOT EXISTS "media_listing_qc_idx" ON "media"("listing_id", "qc_state")`,
  `CREATE INDEX IF NOT EXISTS "activity_created_idx" ON "activity"("created_at" DESC)`,
  `CREATE INDEX IF NOT EXISTS "activity_listing_idx" ON "activity"("listing_id")`,
  `CREATE INDEX IF NOT EXISTS "revision_requests_status_idx" ON "revision_requests"("status")`,
  // ---- v1.2 automatic QC + publish gate (additive only; defaults keep v1.1 code working) ----
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "published" boolean NOT NULL DEFAULT true`,
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "corrected" boolean NOT NULL DEFAULT false`,
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "qc_score" integer`,
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "qc_issues" jsonb`,
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "qc_suggestions" jsonb`,
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "qc_summary" text`,
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "qc_checked_at" timestamp`,
  `ALTER TABLE "shoots" ADD COLUMN IF NOT EXISTS "qc_summary" jsonb`,
  `ALTER TABLE "shoots" ADD COLUMN IF NOT EXISTS "qc_checked_at" timestamp`,
  `CREATE INDEX IF NOT EXISTS "media_listing_pub_idx" ON "media"("listing_id", "qc_state", "published")`,
  // ---- Booking intake, step one (docs/booking-to-payment.md). Additive and idempotent:
  // production code that predates this keeps working on the same rows. ----
  `ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "city" text`,
  `ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "state" text`,
  `ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "zip" text`,
  // invoices: re-key on a uuid id so a Titus checkout (no Stripe id) can be a row.
  // 1. the new id column, filled for existing rows by its default
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL`,
  // 2. swap the primary key: drop the one on stripe_invoice_id (whatever it is
  //    named), then add the one on id when the table has no primary key.
  `DO $$
  DECLARE pk text; pkcol text;
  BEGIN
    SELECT c.conname, a.attname INTO pk, pkcol
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'public.invoices'::regclass AND c.contype = 'p'
     LIMIT 1;
    IF pk IS NOT NULL AND pkcol = 'stripe_invoice_id' THEN
      EXECUTE format('ALTER TABLE public.invoices DROP CONSTRAINT %I', pk);
      pk := NULL;
    END IF;
    IF pk IS NULL THEN
      ALTER TABLE public.invoices ADD CONSTRAINT invoices_pkey PRIMARY KEY ("id");
    END IF;
  END $$`,
  // 3. stripe_invoice_id becomes nullable but stays unique (NULLs distinct), as a
  //    full constraint so the legacy ON CONFLICT (stripe_invoice_id) still infers it.
  `ALTER TABLE "invoices" ALTER COLUMN "stripe_invoice_id" DROP NOT NULL`,
  `DO $$ BEGIN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_stripe_invoice_id_unique" UNIQUE ("stripe_invoice_id");
  EXCEPTION WHEN duplicate_object THEN null; WHEN duplicate_table THEN null; END $$`,
  // 4. provider-agnostic columns; the legacy amount_due / hosted_invoice_url stay populated.
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "provider" text`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "provider_id" text`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "hosted_url" text`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "order_id" text`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "amount_cents" integer`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "currency" text DEFAULT 'usd'`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "method" text`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "paid_at" timestamp`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "refunded_cents" integer`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "description" text`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "line_items" jsonb`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "meta" jsonb`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "client_id" uuid`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "booking_id" uuid`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "idempotency_version" integer NOT NULL DEFAULT 1`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "last_event" jsonb`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "last_checked_at" timestamp`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "env" text`,
  `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL`,
  // 5. legacy webhook rows become Stripe rows (only where nothing is set yet)
  `UPDATE "invoices" SET
     "provider" = 'stripe',
     "provider_id" = "stripe_invoice_id",
     "hosted_url" = COALESCE("hosted_url", "hosted_invoice_url"),
     "amount_cents" = COALESCE("amount_cents", "amount_due"),
     "method" = COALESCE("method", 'card')
   WHERE "provider" IS NULL AND "stripe_invoice_id" IS NOT NULL`,
  `DO $$ BEGIN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "clients"("id");
  EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `CREATE INDEX IF NOT EXISTS "invoices_booking_idx" ON "invoices"("booking_id")`,
  `CREATE INDEX IF NOT EXISTS "invoices_provider_idx" ON "invoices"("provider", "provider_id")`,
  // bookings: one row per form submission (id = the website's submission_id)
  `CREATE TABLE IF NOT EXISTS "bookings" (
    "id" uuid PRIMARY KEY NOT NULL,
    "listing_id" uuid NOT NULL REFERENCES "listings"("id"),
    "client_id" uuid NOT NULL REFERENCES "clients"("id"),
    "invoice_id" uuid REFERENCES "invoices"("id"),
    "content_key" text NOT NULL,
    "calendar_version" integer NOT NULL DEFAULT 1,
    "source" text NOT NULL DEFAULT 'website',
    "market" text,
    "status" text NOT NULL DEFAULT 'requested',
    "payment_method" text,
    "desired_date" date,
    "start_time" text,
    "starts_at" timestamp,
    "ends_at" timestamp,
    "launch_date" date,
    "sqft" integer,
    "tier" integer,
    "service_ids" jsonb,
    "addon_ids" jsonb,
    "services_label" text,
    "custom_request" text,
    "access_notes" text,
    "property" jsonb,
    "signed_name" text,
    "signed_at" timestamp,
    "photographer_email" text,
    "calendar_event_id" text,
    "calendar_synced_at" timestamp,
    "client_notes" text,
    "tonomo_job_id" text,
    "raw" jsonb,
    "env" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "bookings_content_key_idx" ON "bookings"("content_key")`,
  `CREATE INDEX IF NOT EXISTS "bookings_listing_idx" ON "bookings"("listing_id")`,
  `CREATE INDEX IF NOT EXISTS "bookings_client_idx" ON "bookings"("client_id")`,
  `CREATE INDEX IF NOT EXISTS "bookings_created_idx" ON "bookings"("created_at")`,
  // jobs: every side effect, enqueued in the intake batch, drained in after() and by the cron
  `CREATE TABLE IF NOT EXISTS "jobs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "kind" text NOT NULL,
    "payload" jsonb,
    "status" text NOT NULL DEFAULT 'queued',
    "attempts" integer NOT NULL DEFAULT 0,
    "max_attempts" integer NOT NULL DEFAULT 8,
    "run_at" timestamp DEFAULT now() NOT NULL,
    "lease_until" timestamp,
    "last_error" text,
    "idempotency_key" text NOT NULL,
    "env" text NOT NULL,
    "listing_id" uuid,
    "booking_id" uuid,
    "invoice_id" uuid,
    "alerted_at" timestamp,
    "done_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "jobs_idempotency_key_unique" UNIQUE("idempotency_key")
  )`,
  `CREATE INDEX IF NOT EXISTS "jobs_due_idx" ON "jobs"("env", "status", "run_at")`,
  `CREATE INDEX IF NOT EXISTS "jobs_booking_idx" ON "jobs"("booking_id")`,
  // payment_events: every provider webhook delivery, stored before it is acted on
  `CREATE TABLE IF NOT EXISTS "payment_events" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "provider" text NOT NULL,
    "provider_event_id" text NOT NULL,
    "type" text,
    "object_id" text,
    "invoice_id" uuid,
    "status" text,
    "signature_ok" boolean,
    "stale" boolean NOT NULL DEFAULT false,
    "payload" jsonb,
    "env" text,
    "received_at" timestamp DEFAULT now() NOT NULL,
    "processed_at" timestamp,
    "error" text
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "payment_events_provider_event_uq" ON "payment_events"("provider", "provider_event_id")`,
  // step two review: what processing decided, apart from the error column
  `ALTER TABLE "payment_events" ADD COLUMN IF NOT EXISTS "note" text`,
  // settings: tiny key/value store (cron heartbeat "cron.last_tick")
  `CREATE TABLE IF NOT EXISTS "settings" (
    "key" text PRIMARY KEY NOT NULL,
    "value" jsonb,
    "updated_at" timestamp DEFAULT now() NOT NULL
  )`,
  // ---- One portal (Oct 2026): teams with names, admins managed in the UI, notes ----
  `CREATE TABLE IF NOT EXISTS "teams" (
    "slug" text PRIMARY KEY NOT NULL,
    "name" text,
    "notes" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "admins" (
    "email" text PRIMARY KEY NOT NULL,
    "name" text,
    "added_by" text,
    "created_at" timestamp DEFAULT now() NOT NULL
  )`,
  `ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "notes" text`,
  `ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "notes" text`,
  `CREATE INDEX IF NOT EXISTS "clients_team_idx" ON "clients"("team")`,
  // ---- Per-photo revision notes (Oct 2026): one open request per client and
  // listing collects a note per photo; submitted_at is when the client last
  // sent it to the business (null = still adding notes). Older requests were complete
  // when made, so they count as sent at creation.
  `ALTER TABLE "revision_requests" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp`,
  `CREATE TABLE IF NOT EXISTS "revision_items" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "request_id" uuid NOT NULL REFERENCES "revision_requests"("id") ON DELETE CASCADE,
    "listing_id" uuid NOT NULL REFERENCES "listings"("id"),
    "media_id" uuid,
    "filename" text NOT NULL,
    "note" text NOT NULL,
    "client_email" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "revision_items_request_idx" ON "revision_items"("request_id")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "revision_items_request_media_idx" ON "revision_items"("request_id", "media_id")`,
  `UPDATE "revision_requests" SET "submitted_at" = "created_at" WHERE "submitted_at" IS NULL AND NOT EXISTS (SELECT 1 FROM "revision_items" i WHERE i."request_id" = "revision_requests"."id")`,
  // ---- QA team and client visibility (Oct 2026) ----
  // admins.role: admin (everything), qa (the QA team) or, since Oct 21 2026,
  // creative (a creative specialist: Upload a shoot only). Plain text with no
  // check constraint, so the third value needed no DDL. Existing rows stay admin.
  `ALTER TABLE "admins" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'admin' NOT NULL`,
  // media.held: moved to "Internal only" by hand; Publish never flips it.
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "held" boolean DEFAULT false NOT NULL`,
  // ---- Pay another way (Oct 2026): which way a payment_method "other" booking
  // pays (check | ach | cash). Nullable, no default: every existing row stays as it is.
  `ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "payment_detail" text`,
  // Oct 2026: the client can move their own shoot from the portal. The flag
  // stays until an admin confirms the new time.
  `ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "client_rescheduled_at" timestamp`,
  `ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "client_rescheduled_from" text`,
  // Oct 22 2026: the team's internal note on a booking (the status card's
  // Note field, saved with Save note). Nullable, no default.
  `ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "internal_note" text`,
  // ---- Sign-in hardening (Oct 21 2026): one-time magic-link tokens (hashed)
  // and the fixed-window counters behind the login rate limit. Additive. ----
  `CREATE TABLE IF NOT EXISTS "login_tokens" (
    "token_hash" text PRIMARY KEY NOT NULL,
    "email" text NOT NULL,
    "next" text,
    "expires_at" timestamp NOT NULL,
    "used_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "login_tokens_expires_idx" ON "login_tokens"("expires_at")`,
  `CREATE TABLE IF NOT EXISTS "rate_limits" (
    "key" text PRIMARY KEY NOT NULL,
    "count" integer NOT NULL DEFAULT 0,
    "window_start" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "rate_limits_window_idx" ON "rate_limits"("window_start")`,
  // ---- Dropbox raw mirror and raw video uploads (Oct 21 2026). Additive. ----
  // listings.dropbox_folder: "/Listings/<address as it was>", set on the first
  // mirror and kept through later address edits so no file is orphaned.
  `ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "dropbox_folder" text`,
  // shoot_files: where the copy landed and when (null = not copied yet).
  // shoot_files.kind gains the value 'raw_video' (text, no constraint: no DDL).
  `ALTER TABLE "shoot_files" ADD COLUMN IF NOT EXISTS "dropbox_path" text`,
  `ALTER TABLE "shoot_files" ADD COLUMN IF NOT EXISTS "dropbox_synced_at" timestamp`,
  // shoots.dropbox_synced_at: the whole shoot is in Dropbox (one hub line).
  // shoots.status gains the value 'video_only' (text, no constraint: no DDL).
  `ALTER TABLE "shoots" ADD COLUMN IF NOT EXISTS "dropbox_synced_at" timestamp`,
  `CREATE INDEX IF NOT EXISTS "jobs_kind_status_idx" ON "jobs"("env", "kind", "status")`,
  // Inbound client messages: texts from the Quo webhook (Oct 21 2026).
  `CREATE TABLE IF NOT EXISTS "inbound_messages" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "source" text NOT NULL,
    "external_id" text NOT NULL,
    "event_id" text,
    "conversation_id" text,
    "from_addr" text,
    "to_addr" text,
    "body" text,
    "media" jsonb,
    "sent_at" timestamp,
    "env" text,
    "client_id" uuid,
    "listing_id" uuid,
    "status" text DEFAULT 'new' NOT NULL,
    "result" jsonb,
    "processed_at" timestamp,
    "error" text,
    "raw" jsonb,
    "received_at" timestamp DEFAULT now() NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "inbound_messages_source_external_uq" ON "inbound_messages" ("source", "external_id")`,
  `CREATE INDEX IF NOT EXISTS "inbound_messages_status_idx" ON "inbound_messages" ("status")`,
  // Revision intake (Oct 21 2026): where a request came from and the intake's doubts.
  `ALTER TABLE "revision_requests" ADD COLUMN IF NOT EXISTS "source" text`,
  `ALTER TABLE "revision_requests" ADD COLUMN IF NOT EXISTS "source_text" text`,
  `ALTER TABLE "revision_requests" ADD COLUMN IF NOT EXISTS "needs_review" boolean DEFAULT false NOT NULL`,
  `ALTER TABLE "revision_requests" ADD COLUMN IF NOT EXISTS "review_note" text`,
  // Video pipeline (Oct 26 2026): PHOTO / VIDEO tag on every revision, the
  // film review's timestamped comments, the Video board, the client's video
  // notes and the listing's Dropbox Video folder link.
  `ALTER TABLE "revision_requests" ADD COLUMN IF NOT EXISTS "media_kind" text DEFAULT 'photo' NOT NULL`,
  `ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "video_notes" text`,
  `ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "dropbox_video_link" text`,
  `CREATE TABLE IF NOT EXISTS "video_comments" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "listing_id" uuid NOT NULL REFERENCES "listings"("id"),
    "media_id" uuid NOT NULL,
    "filename" text NOT NULL,
    "client_email" text NOT NULL,
    "at_ms" integer NOT NULL,
    "note" text NOT NULL,
    "request_id" uuid REFERENCES "revision_requests"("id") ON DELETE SET NULL,
    "sent_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "video_comments_listing_idx" ON "video_comments" ("listing_id", "client_email")`,
  `CREATE INDEX IF NOT EXISTS "video_comments_request_idx" ON "video_comments" ("request_id")`,
  `CREATE TABLE IF NOT EXISTS "video_projects" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "key" text NOT NULL UNIQUE,
    "listing_id" uuid NOT NULL REFERENCES "listings"("id"),
    "booking_id" uuid,
    "shoot_id" uuid,
    "stage" text DEFAULT 'queue' NOT NULL,
    "assignee" text,
    "editor_notes" text,
    "revision_request_id" uuid,
    "revision_round" integer DEFAULT 0 NOT NULL,
    "footage_at" timestamp,
    "stage_changed_at" timestamp DEFAULT now() NOT NULL,
    "stage_changed_by" text,
    "env" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "video_projects_listing_idx" ON "video_projects" ("listing_id")`,
  `CREATE INDEX IF NOT EXISTS "video_projects_stage_idx" ON "video_projects" ("env", "stage")`,
  // Additional shoots on a booking (Oct 27 2026): return trips, pickup shots,
  // reshoots, twilights, each its own event on the hello@ calendar. The new
  // job kinds calendar.visit_upsert / calendar.visit_cancel need no DDL
  // (jobs.kind is text, no constraint).
  `CREATE TABLE IF NOT EXISTS "booking_visits" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "booking_id" uuid NOT NULL REFERENCES "bookings"("id") ON DELETE CASCADE,
    "listing_id" uuid NOT NULL,
    "env" text,
    "kind" text DEFAULT 'return_trip' NOT NULL,
    "note" text,
    "desired_date" date NOT NULL,
    "start_time" text NOT NULL,
    "starts_at" timestamp NOT NULL,
    "ends_at" timestamp NOT NULL,
    "photographer_email" text,
    "status" text DEFAULT 'scheduled' NOT NULL,
    "calendar_version" integer DEFAULT 1 NOT NULL,
    "calendar_event_id" text,
    "calendar_synced_at" timestamp,
    "created_by" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "booking_visits_booking_idx" ON "booking_visits" ("booking_id")`,
  `CREATE INDEX IF NOT EXISTS "booking_visits_due_idx" ON "booking_visits" ("env", "status", "starts_at")`,
  // A second shoot's own invoice (Oct 27 2026, src/lib/visit-invoice.ts): the
  // card invoice made with "Create new invoice?". No FK (the invoice carries
  // meta.visitId back). Run this before the code that selects it serves.
  `ALTER TABLE "booking_visits" ADD COLUMN IF NOT EXISTS "invoice_id" uuid`,
  // FINAL DELIVERY in Dropbox (Oct 27 2026, src/lib/dropbox-mirror.ts): where a
  // delivered file's copy landed, and which object and size were copied (a
  // replaced final has the same key and new bytes, so both are compared).
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "dropbox_final_path" text`,
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "dropbox_final_key" text`,
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "dropbox_final_bytes" bigint`,
  `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "dropbox_final_at" timestamp`,
  // Folder drops (Oct 27 2026): the folder a raw file was dropped in, relative
  // to the drop ("2311 Elm Street - 413 raw", "video/A001"). The Dropbox
  // copy keeps that path inside the listing folder; null = Photo or Video.
  // Run this before the code that selects it serves.
  `ALTER TABLE "shoot_files" ADD COLUMN IF NOT EXISTS "dropbox_dir" text`,
  // Raws leave R2 once Dropbox holds them (Oct 27 2026, src/lib/r2-raw-cleanup.ts):
  // when the R2 copy was deleted, and the Dropbox content hash both sides
  // matched on before it was. Run this before the code that selects it serves.
  `ALTER TABLE "shoot_files" ADD COLUMN IF NOT EXISTS "r2_deleted_at" timestamp`,
  `ALTER TABLE "shoot_files" ADD COLUMN IF NOT EXISTS "dropbox_hash" text`,
  // Automatic QC fix checkboxes (Nov 2 2026): one row per flag the
  // Photo QC team ticked as done (src/lib/qc-fixes.ts). Additive. The shoot
  // page reads it defensively, but run this before the checkboxes are used.
  `CREATE TABLE IF NOT EXISTS "qc_fix_checks" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "media_id" uuid NOT NULL REFERENCES "media"("id") ON DELETE CASCADE,
    "fix_key" text NOT NULL,
    "checked_by" text NOT NULL,
    "checked_at" timestamp DEFAULT now() NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "qc_fix_checks_media_key_idx" ON "qc_fix_checks" ("media_id", "fix_key")`,
  // The Photo QC status bar (Nov 6 2026): one row per card moved
  // to a column by hand (src/lib/photo-qc.ts), keyed "shoot:<id>" or
  // "revision:<id>", with exactly one of shoot_id / revision_id. Additive.
  // The board reads it defensively (cards stay where the pipeline puts them
  // until this runs), but run this before anyone moves a card.
  `CREATE TABLE IF NOT EXISTS "photo_qc_picks" (
    "card_key" text PRIMARY KEY NOT NULL,
    "shoot_id" uuid REFERENCES "shoots"("id") ON DELETE CASCADE,
    "revision_id" uuid REFERENCES "revision_requests"("id") ON DELETE CASCADE,
    "status" text NOT NULL,
    "set_by" text,
    "set_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "photo_qc_picks_one_card" CHECK (("shoot_id" IS NULL) <> ("revision_id" IS NULL))
  )`,
  // Nov 10 2026: the scorecard (/admin/scorecard, src/lib/scorecard.ts). One
  // row per day, week, shoot mark, task, month or milestone a person's
  // scorecard keeps; the page reads an empty table as a fresh start.
  `CREATE TABLE IF NOT EXISTS "scorecard_entries" (
    "person" text NOT NULL,
    "kind" text NOT NULL,
    "key" text NOT NULL,
    "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "updated_by" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "scorecard_entries_pk" PRIMARY KEY ("person", "kind", "key")
  )`,
  // The website's selection with quantities and the client type (studio-universal).
  `ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "items" jsonb`,
  `ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "client_type" text`,
];

export async function POST(request: Request) {
  if (!hasMigrateToken(request)) {
    return Response.json({ ok: false }, { status: 404 });
  }
  if (!process.env.DATABASE_URL) {
    return Response.json({ ok: false, error: "no DATABASE_URL" }, { status: 503 });
  }
  const sql = neon(process.env.DATABASE_URL);
  for (const stmt of DDL) await sql.query(stmt);

  const body = await request.json().catch(() => ({})); // no/invalid body → DDL-only run

  // Optional bulk client seed: { clients: [{ email, name?, phone?, stripeCustomerId? }] }
  let seeded = 0;
  try {
    for (const c of body?.clients ?? []) {
      const email = String(c.email || "").trim().toLowerCase();
      if (!email) continue;
      await sql`
        insert into clients (email, name, phone, stripe_customer_id)
        values (${email}, ${c.name || null}, ${c.phone || null}, ${c.stripeCustomerId || null})
        on conflict (email) do update set
          name = coalesce(clients.name, excluded.name),
          phone = coalesce(clients.phone, excluded.phone),
          stripe_customer_id = coalesce(clients.stripe_customer_id, excluded.stripe_customer_id)`;
      seeded++;
    }
  } catch {} // no/invalid body → DDL-only run

  const tables = await sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
  const count = await sql`select count(*)::int as n from clients`;
  return Response.json({ ok: true, tables: tables.map((t) => t.table_name), seeded, clientCount: count[0].n });
}
