CREATE TYPE "public"."voice_call_status" AS ENUM('queued', 'ringing', 'in_progress', 'ended', 'failed');--> statement-breakpoint
CREATE TABLE "voice_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"vapi_call_id" text NOT NULL,
	"customer_phone" text NOT NULL,
	"status" "voice_call_status" DEFAULT 'queued' NOT NULL,
	"discount_tier_offered" smallint DEFAULT 0 NOT NULL,
	"discount_amount_paise" bigint,
	"discount_accepted" boolean DEFAULT false NOT NULL,
	"payment_link_id" text,
	"payment_link_url" text,
	"payment_link_amount_paise" bigint,
	"payment_confirmed_at" timestamp with time zone,
	"transcript" jsonb,
	"recording_url" text,
	"ended_reason" text,
	"duration_seconds" integer,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_calls_vapi_call_id_key" ON "voice_calls" USING btree ("vapi_call_id");--> statement-breakpoint
CREATE INDEX "voice_calls_case_idx" ON "voice_calls" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "voice_calls_merchant_idx" ON "voice_calls" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "voice_calls_unconfirmed_idx" ON "voice_calls" USING btree ("ended_at") WHERE status = 'ended' and payment_confirmed_at is null and payment_link_id is not null;