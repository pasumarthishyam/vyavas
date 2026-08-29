/**
 * Channel wiring for the executor.
 *
 * Built lazily and tolerantly: a missing credential disables that channel
 * rather than throwing. The reason is the failure mode it prevents — if a
 * missing Resend key threw at construction, every WhatsApp rung would fail too,
 * and a partial outage would look like a total one.
 *
 * A disabled channel simply never gets selected, `selectChannel` falls through
 * to the next one the policy lists, and the dry-run report shows exactly which
 * rungs had nowhere to go.
 *
 * SCOPED PER MERCHANT, not memoised globally.
 *
 * The clients carry two things that differ per tenant: the Resend key a
 * merchant sends as themselves with, and the routing that decides whether a
 * message reaches the customer or a test inbox. A module-level cache keyed on
 * nothing is how a sandbox message ends up on a live customer's phone after a
 * merchant switch — so the cache is keyed on the merchant, and the merchant is
 * a required argument rather than an ambient default.
 *
 * WhatsApp credentials stay platform-wide on purpose: one Vyavas WhatsApp
 * Business number sends for every merchant. The sender is Vyavas; the copy
 * names the merchant. Only the routing differs.
 */

import { createWhatsAppClient, type WhatsAppClient } from '../adapters/whatsapp/client.js';
import { createEmailClient, type EmailClient } from '../adapters/email/resend.js';
import { env } from '../lib/env.js';
import type { MerchantCredentials } from '../db/repos/credentials.js';
import type { SendChannels } from '../messaging/send.js';

const cache = new Map<string, SendChannels>();

/**
 * Build the channels one merchant sends on.
 *
 * @param creds from `loadMerchantCredentials`. Carries the merchant's own
 *        Resend key and, crucially, where its messages are routed.
 */
export function getChannelsFor(creds: MerchantCredentials): SendChannels {
  const cached = cache.get(creds.merchantId);
  if (cached) return cached;

  const e = env();
  const channels: SendChannels = {};

  if (e.WHATSAPP_ACCESS_TOKEN && e.WHATSAPP_PHONE_NUMBER_ID) {
    channels.whatsapp = createWhatsAppClient({
      redirectTo: creds.routing.whatsappRedirectTo,
    });
  }

  if (creds.email) {
    channels.email = createEmailClient({
      apiKey: creds.email.apiKey,
      ...(creds.email.from ? { defaultFrom: creds.email.from } : {}),
      redirectTo: creds.routing.emailRedirectTo,
    });
  }

  cache.set(creds.merchantId, channels);
  return channels;
}

/**
 * Env-only channels, with no diversion.
 *
 * For scripts and tests that have no merchant in hand. Deliberately NOT used by
 * the executor: a code path that can send without naming a merchant is a code
 * path that can send on the wrong one.
 */
export function getChannels(): SendChannels {
  const e = env();
  const channels: SendChannels = {};

  if (e.WHATSAPP_ACCESS_TOKEN && e.WHATSAPP_PHONE_NUMBER_ID) {
    channels.whatsapp = createWhatsAppClient({
      redirectTo: e.WHATSAPP_REDIRECT_TO ?? null,
    });
  }
  if (e.RESEND_API_KEY) {
    channels.email = createEmailClient({
      ...(e.EMAIL_FROM ? { defaultFrom: e.EMAIL_FROM } : {}),
    });
  }

  return channels;
}

/** Tests inject their own; this clears the per-merchant memo between them. */
export function resetChannels(): void {
  cache.clear();
}

export function configuredChannels(): string[] {
  const c = getChannels();
  return [c.whatsapp ? 'whatsapp' : null, c.email ? 'email' : null].filter(
    (x): x is string => x !== null,
  );
}

export type { SendChannels, WhatsAppClient, EmailClient };
