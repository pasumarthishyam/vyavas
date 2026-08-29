-- Per-merchant credentials and message routing.
--
-- Until now every credential came from one global environment: one Razorpay
-- key pair, one Resend key, one WhatsApp diversion. That works for exactly one
-- merchant and breaks silently at two — the second merchant would send on the
-- first merchant's account.
--
-- Razorpay credentials already had a home in `razorpay_connections` (encrypted,
-- per merchant, per mode); it was simply never populated. This adds the same
-- for email, plus the routing overrides that decide where a message ACTUALLY
-- lands — which must be a property of the merchant rather than of NODE_ENV, so
-- a sandbox merchant can divert while a live merchant does not, both in
-- production.

ALTER TABLE "merchants" ADD COLUMN "resend_api_key_enc" text;
ALTER TABLE "merchants" ADD COLUMN "email_from" text;

-- Routing overrides. NULL means "send to the real recipient".
-- Set means every message on this channel goes here instead, whatever the case
-- says, with the intended recipient still recorded in message_log.
ALTER TABLE "merchants" ADD COLUMN "whatsapp_redirect_to" text;
ALTER TABLE "merchants" ADD COLUMN "email_redirect_to" text;

-- Hard floor between two touches to one person, in minutes.
-- The frequency cap is count-based over 24h and would happily allow a second
-- message five minutes after the first; this is the gap the cap cannot express.
ALTER TABLE "merchants" ADD COLUMN "min_gap_minutes" smallint NOT NULL DEFAULT 360;

-- Minutes after a failure during which the customer is assumed to still be on
-- the checkout page. A first touch inside this window is a RESPONSE, not an
-- outbound campaign, and is exempt from quiet hours.
ALTER TABLE "merchants" ADD COLUMN "live_customer_window_minutes" smallint NOT NULL DEFAULT 15;
