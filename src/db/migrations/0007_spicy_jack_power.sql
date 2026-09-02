CREATE TYPE "public"."abandoned_cart_status" AS ENUM('detected', 'emailed', 'recovered', 'expired', 'failed');--> statement-breakpoint
CREATE TABLE "abandoned_carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"external_cart_id" text NOT NULL,
	"customer_name" text,
	"customer_email" text NOT NULL,
	"customer_phone" text,
	"customer_id" uuid,
	"amount_paise" bigint NOT NULL,
	"status" "abandoned_cart_status" DEFAULT 'detected' NOT NULL,
	"discount_amount_paise" bigint,
	"payment_link_id" text,
	"payment_link_url" text,
	"payment_link_amount_paise" bigint,
	"payment_link_expires_at" timestamp with time zone,
	"payment_confirmed_at" timestamp with time zone,
	"email_sent_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "abandoned_cart_api_key_enc" text;--> statement-breakpoint
ALTER TABLE "abandoned_carts" ADD CONSTRAINT "abandoned_carts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abandoned_carts" ADD CONSTRAINT "abandoned_carts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "abandoned_carts_merchant_external_key" ON "abandoned_carts" USING btree ("merchant_id","external_cart_id");--> statement-breakpoint
CREATE INDEX "abandoned_carts_merchant_idx" ON "abandoned_carts" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "abandoned_carts_pending_idx" ON "abandoned_carts" USING btree ("payment_link_expires_at") WHERE status = 'emailed' and payment_link_id is not null and payment_confirmed_at is null;