/**
 * Webhook signature verification.
 *
 * This is the security boundary of the entire product. Everything downstream —
 * creating cases, messaging customers, eventually re-presenting debits — is
 * driven by what arrives here. An unverified endpoint is one anyone who learns
 * the URL can use to make us message real people about payments that never
 * failed.
 *
 * Two rules that are easy to get wrong and fatal to get wrong:
 *
 *   1. Verify the RAW body, byte for byte. `JSON.parse` then `JSON.stringify`
 *      reorders keys, changes number formatting and drops whitespace, so the
 *      recomputed HMAC will not match — and the usual "fix" is to stop
 *      verifying. Read the body as text first, verify, THEN parse.
 *
 *   2. Compare in constant time. A plain `===` returns as soon as two bytes
 *      differ, leaking how much of a guess was right; enough attempts
 *      reconstruct a valid signature byte by byte.
 */

import { createHmac } from 'node:crypto';

import { safeEqual } from '../../lib/crypto.js';
import { type RazorpayWebhookEnvelope, isSubscribedEvent } from './types.js';

/** Razorpay sends the HMAC here. */
export const SIGNATURE_HEADER = 'x-razorpay-signature';
/** And a stable delivery id here — our dedupe key. */
export const EVENT_ID_HEADER = 'x-razorpay-event-id';

export type VerifyFailure =
  | 'missing_signature'
  | 'invalid_signature'
  | 'empty_body'
  | 'malformed_json'
  | 'missing_event_type';

export type VerifyResult =
  | { ok: true; event: string; envelope: RazorpayWebhookEnvelope; subscribed: boolean }
  | { ok: false; reason: VerifyFailure; detail: string };

/** HMAC-SHA256 of the raw body, hex. Exported for the fixture tooling. */
export function computeSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Verify and parse, in that order.
 *
 * Returns a result rather than throwing: a bad signature is an expected event
 * on a public endpoint, not an exceptional one, and the route needs to answer
 * with a status code rather than a stack trace.
 */
export function verifyWebhook(
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): VerifyResult {
  if (rawBody.length === 0) {
    return { ok: false, reason: 'empty_body', detail: 'Request body was empty' };
  }
  if (!signature) {
    return {
      ok: false,
      reason: 'missing_signature',
      detail: `No ${SIGNATURE_HEADER} header on the request`,
    };
  }

  const expected = computeSignature(rawBody, secret);
  if (!safeEqual(expected, signature)) {
    return {
      ok: false,
      reason: 'invalid_signature',
      detail: 'Signature did not match. Check the webhook secret matches the dashboard.',
    };
  }

  // Only parse once the bytes are proven to come from Razorpay.
  let envelope: RazorpayWebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody) as RazorpayWebhookEnvelope;
  } catch (e) {
    return {
      ok: false,
      reason: 'malformed_json',
      detail: e instanceof Error ? e.message : 'Body was not valid JSON',
    };
  }

  const event = envelope.event;
  if (typeof event !== 'string' || event.length === 0) {
    return { ok: false, reason: 'missing_event_type', detail: 'Envelope had no `event` field' };
  }

  return { ok: true, event, envelope, subscribed: isSubscribedEvent(event) };
}

/**
 * Pull an entity out of the envelope.
 *
 * Razorpay nests as `payload.<entity>.entity`, and which key is present depends
 * on the event — `order.paid` carries both `payment` and `order`, for instance.
 */
export function extractEntity<T extends Record<string, unknown>>(
  envelope: RazorpayWebhookEnvelope,
  key: string,
): T | null {
  const entity = envelope.payload?.[key]?.entity;
  return entity ? (entity as T) : null;
}

/**
 * A stable id for this delivery.
 *
 * Prefers Razorpay's own header. Falls back to a hash of the body so that a
 * delivery arriving without the header is still deduped — dropping to "process
 * it every time" would mean a retry creates a second recovery case.
 */
export function deliveryId(rawBody: string, headerValue: string | null | undefined): string {
  if (headerValue && headerValue.length > 0) return headerValue;
  return `sha256:${createHmac('sha256', 'delivery-id').update(rawBody, 'utf8').digest('hex')}`;
}
