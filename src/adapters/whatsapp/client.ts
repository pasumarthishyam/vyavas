/**
 * WhatsApp Cloud API.
 *
 * Two things about this API that shape the client:
 *
 * 1. **Errors come back as HTTP 200 sometimes and 4xx others**, and the useful
 *    detail is always in `error.code` / `error.error_data.details` rather than
 *    the status. A 131047 (re-engagement required) and a 131026 (undeliverable)
 *    mean completely different things and need completely different responses,
 *    so the codes are classified rather than lumped into "failed".
 *
 * 2. **A rejected variable fails at SEND time, not at template review.** A
 *    newline inside a value, or a blank, returns 132000 at 3am on a real case.
 *    `compose.ts` sanitises; this classifies what gets through anyway.
 */

import { requireWhatsAppConfig } from '../../lib/env.js';

const GRAPH_VERSION = 'v21.0';
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export type WhatsAppFailure =
  | 'invalid_recipient'
  | 'undeliverable'
  | 'template_not_approved'
  | 'variable_rejected'
  | 'rate_limited'
  | 'auth'
  | 'transient'
  | 'unknown';

export interface SendResult {
  ok: boolean;
  /** Meta's `wamid.…`, our handle for delivery receipts. */
  messageId: string | null;
  failure: WhatsAppFailure | null;
  detail: string | null;
  /** False for anything a retry cannot fix. */
  retryable: boolean;
}

/**
 * Map Meta's error codes to something the ladder can act on.
 *
 * The distinction that matters: `undeliverable` and `invalid_recipient` mark
 * the channel dead for this customer, so `gatherFacts` stops offering it and
 * the ladder falls through to email. `transient` is worth another attempt.
 * Treating them alike would either burn attempts on a dead number or discard a
 * customer over one bad minute at Meta.
 */
function classify(code: number | undefined, message: string): {
  failure: WhatsAppFailure;
  retryable: boolean;
} {
  switch (code) {
    case 131026: // message undeliverable
    case 131047: // re-engagement required (outside the 24h window, no template)
      return { failure: 'undeliverable', retryable: false };
    case 131051: // unsupported message type
    case 131008: // required parameter missing
    case 132000: // template param count mismatch / bad variable
    case 132001: // template does not exist
    case 132005: // template hydrated text too long
    case 132007: // template format character policy violated
    case 132012: // template parameter format mismatch
      return { failure: 'variable_rejected', retryable: false };
    case 132015: // template paused
    case 132016: // template disabled
      return { failure: 'template_not_approved', retryable: false };
    case 100: // invalid parameter — usually a malformed recipient
      return { failure: 'invalid_recipient', retryable: false };
    case 190: // access token expired or invalid
    case 200: // permission denied
      return { failure: 'auth', retryable: false };
    case 4:
    case 80007:
    case 130429: // rate limit hit
      return { failure: 'rate_limited', retryable: true };
    case 131000: // generic internal
    case 133016: // temporarily blocked, try later
      return { failure: 'transient', retryable: true };
    default:
      return {
        failure: 'unknown',
        // Unknown codes are treated as retryable only when Meta says so in the
        // message; guessing "retryable" on an unknown permanent failure means
        // hammering a dead number three times.
        retryable: /temporar|try again|rate/i.test(message),
      };
  }
}

export interface WhatsAppClient {
  sendTemplate(input: SendTemplateInput): Promise<SendResult>;
  /**
   * Free-form text. Valid ONLY inside the 24-hour customer service window —
   * the period after the customer messages us first.
   *
   * Not usable for recovery: a customer who abandoned a payment has not
   * written to us, so there is no window and Meta returns 131047. It exists
   * for two real cases: replying to an inbound message (a customer who says
   * "already paid" deserves an answer, not a template), and reading the actual
   * copy on a real phone while templates are still in review.
   */
  sendText(input: SendTextInput): Promise<SendResult>;
}

export interface SendTextInput {
  to: string;
  text: string;
}

export interface SendTemplateInput {
  /** E.164 without the leading `+` is also accepted by Meta; we send it with. */
  to: string;
  templateName: string;
  language: string;
  /** Positional body variables, matching {{1}}…{{n}}. */
  variables: readonly string[];
}

export interface WhatsAppClientOptions {
  accessToken?: string;
  phoneNumberId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Divert every message to this number instead of the customer's.
   *
   * Passed in explicitly by the caller, which is always the merchant's own
   * routing setting. Null means send to the real recipient.
   */
  redirectTo?: string | null;
}

export function createWhatsAppClient(opts: WhatsAppClientOptions = {}): WhatsAppClient {
  const cfg =
    opts.accessToken && opts.phoneNumberId
      ? { accessToken: opts.accessToken, phoneNumberId: opts.phoneNumberId }
      : requireWhatsAppConfig();

  const base = opts.baseUrl ?? BASE;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  /**
   * Test diversion.
   *
   * When set, every message goes to one number instead of the customer's. That
   * makes it possible to run a PRODUCTION Razorpay account through the whole
   * ladder — real failures, real diagnosis, real sends — without a real
   * customer receiving anything.
   *
   * It is a MERCHANT property, passed in by the caller, and deliberately not an
   * environment flag. The previous version refused to divert whenever
   * NODE_ENV was 'production', on the reasoning that a diversion left on in
   * production would funnel every customer's message to one phone while the
   * merchant saw "delivered".
   *
   * That reasoning holds only if production means real customers. It stops
   * holding the moment a sandbox merchant and a live merchant run on the same
   * deployment — which is exactly the setup this system needs — and it failed
   * in the dangerous direction: the safety net switched itself off on deploy,
   * silently, while the console still reported messages as diverted.
   *
   * Per merchant, the sandbox diverts and the live account does not, both in
   * production, both stated explicitly in the UI from this same value.
   */
  const redirectTo = opts.redirectTo ? opts.redirectTo.replace(/[^\d]/g, '') : null;

  function route(to: string): string {
    if (!redirectTo) return to;
    const cleaned = to.replace(/[^\d]/g, '');
    if (cleaned !== redirectTo) {
      console.warn(`  [whatsapp] diverted ${cleaned} -> ${redirectTo} (merchant routing)`);
    }
    return redirectTo;
  }

  /** Both send paths differ only in the body they POST. */
  async function post(to: string, payload: Record<string, unknown>): Promise<SendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await doFetch(`${base}/${cfg.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          ...payload,
        }),
        signal: controller.signal,
      });

      const json = (await res.json()) as {
        messages?: { id: string }[];
        error?: { code?: number; message?: string; error_data?: { details?: string } };
      };

      if (res.ok && json.messages?.[0]?.id) {
        return {
          ok: true,
          messageId: json.messages[0].id,
          failure: null,
          detail: null,
          retryable: false,
        };
      }

      const err = json.error ?? {};
      const detail = err.error_data?.details ?? err.message ?? `HTTP ${res.status}`;
      const { failure, retryable } = classify(err.code, detail);
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
  }

  return {
    async sendText(input: SendTextInput): Promise<SendResult> {
      return post(route(input.to), { type: 'text', text: { preview_url: true, body: input.text } });
    },

    async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
      // Routed through the same `post` helper as sendText, so the test
      // diversion cannot be bypassed by one path. A duplicated fetch here was
      // exactly how the template path escaped it.
      return post(route(input.to), {
        type: 'template',
        template: {
          name: input.templateName,
          language: { code: input.language },
          components:
            input.variables.length > 0
              ? [
                  {
                    type: 'body',
                    parameters: input.variables.map((text) => ({ type: 'text', text })),
                  },
                ]
              : [],
        },
      });
    },
  };
}
