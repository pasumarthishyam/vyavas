/**
 * Email, via Resend.
 *
 * The fallback channel, and the only one with no template approval: email has
 * no equivalent of Meta's review, so the rendered preview from `compose.ts` IS
 * the email body. Same words either way — the copy lives in one place and both
 * channels read from it.
 *
 * Deliberately plain text rather than HTML. A recovery message is a short
 * transactional note; an HTML template with a logo and a button reads as
 * marketing to both the recipient and the spam filter, and this is exactly the
 * category of mail that must not.
 */

import { requireResendKey } from '../../lib/env.js';

const BASE = 'https://api.resend.com';

export type EmailFailure = 'invalid_recipient' | 'rate_limited' | 'auth' | 'transient' | 'unknown';

export interface EmailResult {
  ok: boolean;
  messageId: string | null;
  failure: EmailFailure | null;
  detail: string | null;
  retryable: boolean;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  /** Plain text. Line breaks preserved as sent. */
  text: string;
  /** Overrides the configured default sender. */
  from?: string;
  replyTo?: string;
}

export interface EmailClientOptions {
  apiKey?: string;
  /**
   * Defaults to Resend's shared testing sender, which needs no DNS setup but
   * can only deliver to the address that owns the Resend account. A verified
   * domain is required before this reaches a real customer.
   */
  defaultFrom?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Divert every email to this address instead of the customer's.
   *
   * The merchant's own routing setting, passed in explicitly — same contract as
   * the WhatsApp diversion, so a sandbox merchant behaves identically on both
   * channels. Null means send to the real recipient.
   */
  redirectTo?: string | null;
}

export interface EmailClient {
  send(input: SendEmailInput): Promise<EmailResult>;
}

function classify(status: number, message: string): { failure: EmailFailure; retryable: boolean } {
  if (status === 401 || status === 403) return { failure: 'auth', retryable: false };
  if (status === 422 || status === 400) return { failure: 'invalid_recipient', retryable: false };
  if (status === 429) return { failure: 'rate_limited', retryable: true };
  if (status >= 500) return { failure: 'transient', retryable: true };
  return { failure: 'unknown', retryable: /temporar|try again/i.test(message) };
}

export function createEmailClient(opts: EmailClientOptions = {}): EmailClient {
  const apiKey = opts.apiKey ?? requireResendKey();
  const defaultFrom = opts.defaultFrom ?? 'Vyavas <onboarding@resend.dev>';
  const base = opts.baseUrl ?? BASE;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const redirectTo = opts.redirectTo ?? null;

  function route(to: string): string {
    if (!redirectTo || to === redirectTo) return to;
    console.warn(`  [email] diverted ${to} -> ${redirectTo} (merchant routing)`);
    return redirectTo;
  }

  return {
    async send(input: SendEmailInput): Promise<EmailResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await doFetch(`${base}/emails`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: input.from ?? defaultFrom,
            to: [route(input.to)],
            subject: input.subject,
            text: input.text,
            reply_to: input.replyTo,
          }),
          signal: controller.signal,
        });

        const json = (await res.json()) as { id?: string; message?: string; name?: string };

        if (res.ok && json.id) {
          return { ok: true, messageId: json.id, failure: null, detail: null, retryable: false };
        }

        const detail = json.message ?? json.name ?? `HTTP ${res.status}`;
        const { failure, retryable } = classify(res.status, detail);
        return { ok: false, messageId: null, failure, detail, retryable };
      } catch (e) {
        return {
          ok: false,
          messageId: null,
          failure: 'transient',
          detail: e instanceof Error ? e.message : String(e),
          retryable: true,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
