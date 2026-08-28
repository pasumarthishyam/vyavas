/**
 * Channel wiring for the executor.
 *
 * Built lazily and tolerantly: a missing credential disables that channel
 * rather than throwing. The reason is the failure mode it prevents — if a
 * missing `RESEND_API_KEY` threw at construction, every WhatsApp rung would
 * fail too, and a partial outage would look like a total one.
 *
 * A disabled channel simply never gets selected, `selectChannel` falls through
 * to the next one the policy lists, and the dry-run report shows exactly which
 * rungs had nowhere to go.
 */

import { createWhatsAppClient, type WhatsAppClient } from '../adapters/whatsapp/client.js';
import { createEmailClient, type EmailClient } from '../adapters/email/resend.js';
import { env } from '../lib/env.js';
import type { SendChannels } from '../messaging/send.js';

let cached: SendChannels | null = null;

export function getChannels(): SendChannels {
  if (cached) return cached;

  const e = env();
  const channels: SendChannels = {};

  if (e.WHATSAPP_ACCESS_TOKEN && e.WHATSAPP_PHONE_NUMBER_ID) {
    channels.whatsapp = createWhatsAppClient();
  }
  if (e.RESEND_API_KEY) {
    channels.email = createEmailClient({
      ...(e.EMAIL_FROM ? { defaultFrom: e.EMAIL_FROM } : {}),
    });
  }

  cached = channels;
  return channels;
}

/** Tests inject their own; this clears the memo between them. */
export function resetChannels(): void {
  cached = null;
}

export function configuredChannels(): string[] {
  const c = getChannels();
  return [c.whatsapp ? 'whatsapp' : null, c.email ? 'email' : null].filter(
    (x): x is string => x !== null,
  );
}

export type { SendChannels, WhatsAppClient, EmailClient };
