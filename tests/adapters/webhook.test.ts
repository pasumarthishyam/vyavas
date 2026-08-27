/**
 * Webhook verification.
 *
 * The security boundary of the entire product. Everything downstream — creating
 * cases, messaging customers, eventually re-presenting debits — is driven by
 * what gets past this function.
 */

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  computeSignature,
  deliveryId,
  extractEntity,
  verifyWebhook,
} from '@adapters/razorpay/webhook.js';
import { paymentFailedEnvelope } from '@adapters/razorpay/fixtures/webhooks.js';

const SECRET = 'whsec_test_abcdef123456';
const body = JSON.stringify(paymentFailedEnvelope());
const validSignature = computeSignature(body, SECRET);

describe('signature verification', () => {
  it('accepts a correctly signed body', () => {
    const r = verifyWebhook(body, validSignature, SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event).toBe('payment.failed');
      expect(r.subscribed).toBe(true);
    }
  });

  it('rejects a wrong signature', () => {
    const r = verifyWebhook(body, computeSignature(body, 'a_different_secret'), SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_signature');
  });

  it('rejects a missing signature', () => {
    for (const sig of [null, undefined, '']) {
      const r = verifyWebhook(body, sig, SECRET);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('missing_signature');
    }
  });

  it('rejects a tampered body', () => {
    // Someone intercepts a real webhook and inflates the amount. The signature
    // was computed over the original bytes, so it no longer matches.
    const tampered = body.replace('184300', '9999900');
    const r = verifyWebhook(tampered, validSignature, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_signature');
  });

  it('rejects a body that was re-serialised rather than passed through raw', () => {
    // The classic mistake: parse the body, then verify against JSON.stringify
    // of the parsed object. Key order and formatting change, so the HMAC no
    // longer matches — and the usual "fix" is to stop verifying.
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    const r = verifyWebhook(reserialised, validSignature, SECRET);
    expect(r.ok).toBe(false);
  });

  it('rejects an empty body', () => {
    const r = verifyWebhook('', validSignature, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty_body');
  });

  it('only parses JSON after the signature checks out', () => {
    const garbage = '{not json';
    // Unsigned garbage must fail on the signature, never reach the parser.
    const unsigned = verifyWebhook(garbage, 'deadbeef', SECRET);
    expect(unsigned.ok).toBe(false);
    if (!unsigned.ok) expect(unsigned.reason).toBe('invalid_signature');

    // Correctly signed garbage fails on the parse, and says so.
    const signed = verifyWebhook(garbage, computeSignature(garbage, SECRET), SECRET);
    expect(signed.ok).toBe(false);
    if (!signed.ok) expect(signed.reason).toBe('malformed_json');
  });

  it('rejects an envelope with no event type', () => {
    const noEvent = JSON.stringify({ entity: 'event', payload: {} });
    const r = verifyWebhook(noEvent, computeSignature(noEvent, SECRET), SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_event_type');
  });

  it('flags an event outside our subscription without rejecting it', () => {
    // Razorpay adds events. One we do not handle should be visible, not fatal.
    const other = JSON.stringify({ entity: 'event', event: 'settlement.processed', payload: {} });
    const r = verifyWebhook(other, computeSignature(other, SECRET), SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.subscribed).toBe(false);
  });

  it('matches an independently computed HMAC-SHA256', () => {
    const independent = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
    expect(computeSignature(body, SECRET)).toBe(independent);
  });
});

describe('deliveryId', () => {
  it('prefers the Razorpay event id header', () => {
    expect(deliveryId(body, 'evt_abc123')).toBe('evt_abc123');
  });

  it('falls back to a body hash so a header-less delivery is still deduped', () => {
    // Dropping to "process it every time" would mean a retry creates a second
    // recovery case and the customer gets two ladders.
    const a = deliveryId(body, null);
    const b = deliveryId(body, '');
    expect(a).toBe(b);
    expect(a.startsWith('sha256:')).toBe(true);
    expect(deliveryId(body + ' ', null)).not.toBe(a);
  });
});

describe('extractEntity', () => {
  it('unwraps the nested payload', () => {
    const envelope = paymentFailedEnvelope({ paymentId: 'pay_X' });
    expect(extractEntity(envelope, 'payment')?.id).toBe('pay_X');
  });

  it('returns null for an absent key rather than throwing', () => {
    expect(extractEntity(paymentFailedEnvelope(), 'order')).toBeNull();
    expect(extractEntity({}, 'payment')).toBeNull();
  });
});

describe('header names', () => {
  it('uses the documented Razorpay headers', () => {
    expect(SIGNATURE_HEADER).toBe('x-razorpay-signature');
    expect(EVENT_ID_HEADER).toBe('x-razorpay-event-id');
  });
});
