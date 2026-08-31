/**
 * Redaction for the audit trail.
 *
 * The feed renders free text we did not write — provider failure messages,
 * event payloads — and both routinely carry customer contact details. These
 * tests are the guard, because the failure mode is silent: a leaked phone
 * number renders exactly as well as a masked one, and the first person to
 * notice is whoever the screenshot reaches.
 *
 * The bias throughout is toward over-masking. A masked order id is a cosmetic
 * problem; a real mobile number in a shared screen is not.
 */

import { describe, expect, it } from 'vitest';

import { redact, redactShort } from '../../src/lib/redact.js';

describe('redact', () => {
  it('passes ordinary text through untouched', () => {
    const s = 'already 2 message(s) in 24h (cap 2)';
    expect(redact(s)).toBe(s);
  });

  it('returns null for null, so callers do not need a guard', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeNull();
  });

  it('masks an email but keeps the domain', () => {
    // The domain is operationally useful — a run of failures to one domain is a
    // deliverability problem worth seeing — and it is not personal on its own.
    expect(redact('bounced for rahulsharma@gmail.com')).toBe('bounced for rah•••@gmail.com');
  });

  it('masks Indian mobile numbers in every shape a provider sends them', () => {
    for (const raw of [
      '+919876543210',
      '919876543210',
      '9876543210',
      '+91 98765 43210',
      '+91-98765-43210',
    ]) {
      const out = redact(`undeliverable to ${raw}`)!;
      expect(out, raw).not.toContain('9876543210');
      expect(out, raw).toContain('•••••');
    }
  });

  /**
   * A Razorpay short link is a per-customer bearer URL: anyone holding it can
   * open that customer's checkout. The host alone says which provider issued
   * it, which is all the trail needs.
   */
  it('reduces a payment link to its host', () => {
    expect(redact('created https://rzp.io/i/aBc123XyZ')).toBe('created rzp.io/…');
    expect(redact('see https://example.com')).toBe('see example.com');
  });

  it('handles several secrets in one sentence', () => {
    const out = redact('failed for a@b.com and +919876543210 via https://rzp.io/i/zz9')!;
    expect(out).not.toContain('a@b.com');
    expect(out).not.toContain('9876543210');
    expect(out).not.toContain('/i/zz9');
  });

  /**
   * The counterweight to over-masking. Amounts, HTTP codes, rung offsets and
   * error codes are short digit runs, and masking them would make the trail
   * unreadable to protect nothing.
   */
  it('leaves short digit runs alone', () => {
    for (const s of [
      'already 2 message(s) in 24h (cap 2)',
      'rung 3 deferred',
      'HTTP 429 rate limited',
      'error 131026',
      'Rs 9,588 at risk',
    ]) {
      expect(redact(s), s).toBe(s);
    }
  });

  it('does not mangle a UUID', () => {
    const id = 'case 27977061-2670-4a1c-ab80-14c32cb58371 aborted';
    expect(redact(id)).toBe(id);
  });

  it('masks a 12-digit number, which is long enough to be a phone', () => {
    const out = redact('ref 919876543210 failed')!;
    expect(out).not.toContain('919876543210');
  });
});

describe('redactShort', () => {
  it('clips long text and marks the cut', () => {
    const out = redactShort('x'.repeat(300), 50)!;
    expect(out.length).toBe(51);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves short text alone', () => {
    expect(redactShort('fine', 50)).toBe('fine');
  });

  /**
   * The ordering bug this exists to prevent: clipping first can cut a phone
   * number in half, leaving digits the pattern no longer matches — so the mask
   * that would have caught it never fires.
   */
  it('redacts BEFORE it clips', () => {
    const text = `undeliverable to +919876543210 because the number is not on WhatsApp`;
    const out = redactShort(text, 30)!;
    expect(out).not.toContain('9876543210');
  });
});
