CREATE TYPE "public"."action_kind" AS ENUM('nudge', 'create_payment_link', 'expire_payment_link', 'retry_debit', 'send_pre_debit_notice', 'merchant_alert', 'await_downtime_resolution', 'escalate_to_human', 'close_case', 'no_op');--> statement-breakpoint
CREATE TYPE "public"."action_status" AS ENUM('planned', 'skipped', 'executed', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."case_state" AS ENUM('detected', 'diagnosed', 'executing', 'paused', 'recovered', 'lost', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."case_type" AS ENUM('payment_failure', 'intent_exit', 'subscription_failure', 'receivable_overdue');--> statement-breakpoint
CREATE TYPE "public"."cause_class" AS ENUM('transient_infra', 'instrument_dead', 'customer_input', 'auth_friction', 'funds_limits', 'risk', 'merchant_config', 'terminal_noop', 'intent_exit');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('whatsapp', 'sms', 'email', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."cohort" AS ENUM('treatment', 'holdout');--> statement-breakpoint
CREATE TYPE "public"."connection_mode" AS ENUM('test', 'live');--> statement-breakpoint
CREATE TYPE "public"."connection_scope" AS ENUM('read_only', 'read_write');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."downtime_severity" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."error_source" AS ENUM('customer', 'business', 'bank', 'gateway', 'issuer', 'network', 'internal', 'nbfc', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."error_step" AS ENUM('payment_initiation', 'payment_authentication', 'payment_authorization', 'payment_capture', 'payment_response', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'delivered', 'read', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('card', 'upi', 'netbanking', 'wallet', 'emi', 'cardless_emi', 'paylater', 'bank_transfer', 'nach', 'unknown');--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"execution_enabled" boolean DEFAULT false NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"holdout_basis_points" integer DEFAULT 500 NOT NULL,
	"holdout_enabled" boolean DEFAULT true NOT NULL,
	"frequency_cap_per_day" smallint DEFAULT 2 NOT NULL,
	"live_attempt_lock_minutes" smallint DEFAULT 3 NOT NULL,
	"quiet_hours_start" smallint DEFAULT 21 NOT NULL,
	"quiet_hours_end" smallint DEFAULT 8 NOT NULL,
	"daily_message_budget" integer DEFAULT 1000 NOT NULL,
	"daily_debit_budget_paise" bigint DEFAULT 0 NOT NULL,
	"commission_basis_points" integer DEFAULT 1500 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "razorpay_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"mode" "connection_mode" NOT NULL,
	"scope" "connection_scope" DEFAULT 'read_only' NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"rzp_account_id" text,
	"key_id" text NOT NULL,
	"key_secret_enc" text NOT NULL,
	"webhook_secret_enc" text,
	"oauth_refresh_token_enc" text,
	"oauth_access_token_enc" text,
	"oauth_expires_at" timestamp with time zone,
	"backfilled_through" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"external_ref" text,
	"rzp_customer_id" text,
	"email" text,
	"phone" text,
	"name" text,
	"locale" text DEFAULT 'en-IN' NOT NULL,
	"whatsapp_opt_in" boolean DEFAULT false NOT NULL,
	"sms_opt_in" boolean DEFAULT false NOT NULL,
	"email_opt_in" boolean DEFAULT false NOT NULL,
	"opted_out_at" timestamp with time zone,
	"opt_out_reason" text,
	"phone_undeliverable_at" timestamp with time zone,
	"email_undeliverable_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"rung" smallint NOT NULL,
	"kind" "action_kind" NOT NULL,
	"status" "action_status" DEFAULT 'planned' NOT NULL,
	"idempotency_key" text NOT NULL,
	"skip_reason" text,
	"params" jsonb,
	"result" jsonb,
	"error" text,
	"scheduled_for" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_state" "case_state",
	"to_state" "case_state",
	"reason" text,
	"actor" text DEFAULT 'system' NOT NULL,
	"payload" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"case_id" uuid,
	"rzp_order_id" text,
	"rzp_payment_id" text NOT NULL,
	"method" "payment_method" DEFAULT 'unknown' NOT NULL,
	"error_reason" text,
	"error_source" "error_source",
	"bank" text,
	"succeeded" boolean DEFAULT false NOT NULL,
	"amount_paise" bigint NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"customer_id" uuid,
	"type" "case_type" NOT NULL,
	"state" "case_state" DEFAULT 'detected' NOT NULL,
	"amount_at_risk_paise" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"rzp_order_id" text,
	"rzp_payment_id" text,
	"rzp_invoice_id" text,
	"rzp_subscription_id" text,
	"rzp_payment_link_id" text,
	"error_code" text,
	"error_source" "error_source",
	"error_step" "error_step",
	"error_reason" text,
	"method" "payment_method" DEFAULT 'unknown' NOT NULL,
	"bank" text,
	"network" text,
	"raw_error_reason" text,
	"cause_class" "cause_class",
	"confidence" text,
	"diagnosis_rationale" jsonb,
	"attended" boolean DEFAULT true NOT NULL,
	"mandate_id" text,
	"policy_id" text,
	"policy_version" integer,
	"cohort" "cohort" DEFAULT 'treatment' NOT NULL,
	"current_rung" smallint DEFAULT 0 NOT NULL,
	"messages_sent" smallint DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"recovered_amount_paise" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"case_id" uuid,
	"rung" smallint DEFAULT 0 NOT NULL,
	"channel" "channel" NOT NULL,
	"intent" text NOT NULL,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"template_id" text,
	"locale" text,
	"body" text,
	"provider_message_id" text,
	"provider_response" jsonb,
	"error" text,
	"idempotency_key" text NOT NULL,
	"suppressed_reason" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "downtime_windows" (
	"id" text PRIMARY KEY NOT NULL,
	"method" "payment_method" NOT NULL,
	"bank" text,
	"network" text,
	"issuer" text,
	"psp" text,
	"severity" "downtime_severity" DEFAULT 'medium' NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"signal" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"affected_cases" integer DEFAULT 0 NOT NULL,
	"amount_at_risk_paise" bigint DEFAULT 0 NOT NULL,
	"baseline_rate_bps" integer,
	"onset_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"merchant_id" uuid,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "razorpay_connections" ADD CONSTRAINT "razorpay_connections_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_actions" ADD CONSTRAINT "case_actions_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_log" ADD CONSTRAINT "message_log_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_log" ADD CONSTRAINT "message_log_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_log" ADD CONSTRAINT "message_log_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_alerts" ADD CONSTRAINT "merchant_alerts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_slug_key" ON "merchants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "rzp_conn_merchant_mode_key" ON "razorpay_connections" USING btree ("merchant_id","mode") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "rzp_conn_account_idx" ON "razorpay_connections" USING btree ("rzp_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_merchant_phone_key" ON "customers" USING btree ("merchant_id","phone") WHERE phone is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_merchant_email_key" ON "customers" USING btree ("merchant_id","email") WHERE email is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_merchant_external_key" ON "customers" USING btree ("merchant_id","external_ref") WHERE external_ref is not null;--> statement-breakpoint
CREATE INDEX "customers_merchant_idx" ON "customers" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_actions_idempotency_key" ON "case_actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "case_actions_case_idx" ON "case_actions" USING btree ("case_id","rung");--> statement-breakpoint
CREATE INDEX "case_actions_merchant_idx" ON "case_actions" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "case_events_case_idx" ON "case_events" USING btree ("case_id","occurred_at");--> statement-breakpoint
CREATE INDEX "case_events_merchant_idx" ON "case_events" USING btree ("merchant_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_payment_key" ON "payment_attempts" USING btree ("merchant_id","rzp_payment_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_order_idx" ON "payment_attempts" USING btree ("merchant_id","rzp_order_id","attempted_at");--> statement-breakpoint
CREATE INDEX "payment_attempts_recent_idx" ON "payment_attempts" USING btree ("merchant_id","attempted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_cases_live_order_key" ON "recovery_cases" USING btree ("merchant_id","rzp_order_id") WHERE state in ('detected','diagnosed','executing','paused') and rzp_order_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_cases_live_invoice_key" ON "recovery_cases" USING btree ("merchant_id","rzp_invoice_id") WHERE state in ('detected','diagnosed','executing','paused') and rzp_invoice_id is not null;--> statement-breakpoint
CREATE INDEX "recovery_cases_merchant_state_idx" ON "recovery_cases" USING btree ("merchant_id","state");--> statement-breakpoint
CREATE INDEX "recovery_cases_customer_idx" ON "recovery_cases" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "recovery_cases_deadline_idx" ON "recovery_cases" USING btree ("deadline_at") WHERE state in ('detected','diagnosed','executing','paused');--> statement-breakpoint
CREATE INDEX "recovery_cases_dashboard_idx" ON "recovery_cases" USING btree ("merchant_id","cause_class","created_at");--> statement-breakpoint
CREATE INDEX "recovery_cases_payment_idx" ON "recovery_cases" USING btree ("rzp_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_log_idempotency_key" ON "message_log" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "message_log_customer_recent_idx" ON "message_log" USING btree ("customer_id","sent_at") WHERE suppressed_reason is null;--> statement-breakpoint
CREATE INDEX "message_log_case_idx" ON "message_log" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "message_log_merchant_idx" ON "message_log" USING btree ("merchant_id","sent_at");--> statement-breakpoint
CREATE INDEX "downtime_open_idx" ON "downtime_windows" USING btree ("method","bank") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "downtime_started_idx" ON "downtime_windows" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_alerts_open_signal_key" ON "merchant_alerts" USING btree ("merchant_id","signal") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "merchant_alerts_merchant_idx" ON "merchant_alerts" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_events_type_idx" ON "webhook_events" USING btree ("event_type","received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("received_at") WHERE processed_at is null;