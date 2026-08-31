-- The two human-in-the-loop queues.
--
-- `escalations`        cases the ladder handed to a person. Until now
--                      `escalate_to_human` wrote a `case_actions` row and
--                      stopped: no queue, no notification, no UI, and a static
--                      note copied from the YAML. Nobody was ever told.
--
-- `taxonomy_proposals` proposed cause classes for failure reasons we do not
--                      know. Nothing reads this back — accepting a proposal
--                      means a person hand-writes the rule into codes.ts.
--
-- ── a note for whoever generates the next migration ──
--
-- `drizzle-kit generate` produced six spurious `ALTER TABLE "merchants" ADD
-- COLUMN` statements alongside this, for columns 0003 already created
-- (min_gap_minutes, live_customer_window_minutes, resend_api_key_enc,
-- email_from, whatsapp_redirect_to, email_redirect_to). They were removed by
-- hand; running them would fail with "column already exists" against any
-- database that has had 0003 applied, which is all of them.
--
-- The cause is that 0003 and 0004 were written by hand and never got a meta
-- snapshot, so drizzle-kit diffed this schema against 0002. `0005_snapshot.json`
-- IS generated from the real schema, so the next diff runs from a correct
-- baseline and this should not recur.

CREATE TYPE "public"."escalation_queue" AS ENUM('merchant_review', 'risk_review', 'ar_collections');--> statement-breakpoint
CREATE TYPE "public"."escalation_status" AS ENUM('open', 'acknowledged', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"queue" "escalation_queue" NOT NULL,
	"status" "escalation_status" DEFAULT 'open' NOT NULL,
	"rung" smallint DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"headline" text NOT NULL,
	"what_happened" text,
	"what_we_tried" text,
	"what_is_blocking" text,
	"recommended_action" text,
	"brief_confidence" text,
	"brief_source" text DEFAULT 'fallback' NOT NULL,
	"brief_error" text,
	"amount_at_risk_paise" bigint DEFAULT 0 NOT NULL,
	"cause_class" "cause_class",
	"assigned_to" text,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taxonomy_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_error_reason" text NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"proposed_cause_class" "cause_class" NOT NULL,
	"confidence" text NOT NULL,
	"reasoning" text NOT NULL,
	"proposed_rule_id" text NOT NULL,
	"disambiguation_note" text,
	"same_instrument_retry_safe" boolean DEFAULT false NOT NULL,
	"reviewer_should_verify" text,
	"occurrences" integer DEFAULT 0 NOT NULL,
	"distinct_merchants" integer DEFAULT 0 NOT NULL,
	"eventually_paid_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"evidence" jsonb,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "escalations_idempotency_key" ON "escalations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "escalations_open_idx" ON "escalations" USING btree ("merchant_id","queue","created_at") WHERE status in ('open','acknowledged');--> statement-breakpoint
CREATE INDEX "escalations_case_idx" ON "escalations" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "taxonomy_proposals_pending_key" ON "taxonomy_proposals" USING btree ("raw_error_reason") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "taxonomy_proposals_status_idx" ON "taxonomy_proposals" USING btree ("status","created_at");
