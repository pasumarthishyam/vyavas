import { describe, expect, it } from 'vitest';
import {
  normalizeBank,
  normalizeErrorTuple,
  normalizeFailure,
  normalizeMethod,
  normalizeSource,
  normalizeStep,
  normalizeTimestamp,
} from '@core/taxonomy/normalize.js';

/** Shaped after a real Razorpay `payload.payment.entity` from `payment.failed`. */
const CARD_FAILURE = {
  id: 'pay_29QQoUBi66xm2f',
  entity: 'payment',
  amount: 184300,
  currency: 'INR',
  status: 'failed',
  order_id: 'order_9A33XWu170gUtm',
  method: 'card',
  email: 'Rahul@Example.COM',
  contact: '+919876543210',
  error_code: 'BAD_REQUEST_ERROR',
  error_description: 'Your card has expired. Try another card.',
  error_source: 'customer',
  error_step: 'payment_authorization',
  error_reason: 'card_expired',
  card: { network: 'visa', issuer: 'hdfc', type: 'debit' },
  created_at: 1723459200,
} as const;

describe('normalizeErrorTuple', () => {
  it('extracts the full five-field tuple plus routing context', () => {
    const t = normalizeErrorTuple(CARD_FAILURE);
    expect(t).toEqual({
      errorCode: 'BAD_REQUEST_ERROR',
      errorSource: 'customer',
      errorStep: 'payment_authorization',
      errorReason: 'card_expired',
      method: 'card',
      bank: 'HDFC',
      network: 'VISA',
    });
  });

  it('reads the bank from card.issuer for cards and top-level for netbanking', () => {
    expect(normalizeErrorTuple({ method: 'card', card: { issuer: 'icic' } }).bank).toBe('ICIC');
    expect(normalizeErrorTuple({ method: 'netbanking', bank: 'utib' }).bank).toBe('UTIB');
  });

  it('maps an undocumented reason into the unknown bucket rather than dropping it', () => {
    const t = normalizeErrorTuple({ ...CARD_FAILURE, error_reason: 'brand_new_code_from_rzp' });
    expect(t.errorReason).toBe('unknown_reason');
  });

  it('survives a completely empty entity', () => {
    const t = normalizeErrorTuple({});
    expect(t.errorReason).toBe('unknown_reason');
    expect(t.method).toBe('unknown');
    expect(t.errorSource).toBe('unknown');
    expect(t.errorStep).toBe('unknown');
    expect(t.bank).toBeNull();
  });
});

describe('field normalisers', () => {
  it('normalises source, mapping merchant -> business', () => {
    expect(normalizeSource('CUSTOMER')).toBe('customer');
    expect(normalizeSource('merchant')).toBe('business');
    expect(normalizeSource('something_new')).toBe('unknown');
    expect(normalizeSource(undefined)).toBe('unknown');
  });

  it('normalises both spellings of authorisation', () => {
    expect(normalizeStep('payment_authorisation')).toBe('payment_authorization');
    expect(normalizeStep('payment_authorization')).toBe('payment_authorization');
  });

  it('collapses method aliases', () => {
    expect(normalizeMethod('credit_card')).toBe('card');
    expect(normalizeMethod('upi_collect')).toBe('upi');
    expect(normalizeMethod('net_banking')).toBe('netbanking');
    expect(normalizeMethod('emandate')).toBe('nach');
    expect(normalizeMethod('carrier_pigeon')).toBe('unknown');
  });

  it('uppercases bank codes so downtime joins and policy matches line up', () => {
    expect(normalizeBank('hdfc')).toBe('HDFC');
    expect(normalizeBank('  ')).toBeNull();
    expect(normalizeBank(null)).toBeNull();
  });

  it('reads Razorpay second-precision timestamps without landing in 1970', () => {
    const d = normalizeTimestamp(1723459200);
    expect(d?.getUTCFullYear()).toBe(2024);
    // Already-millisecond values pass through unchanged.
    expect(normalizeTimestamp(1723459200000)?.getUTCFullYear()).toBe(2024);
    expect(normalizeTimestamp(0)).toBeNull();
    expect(normalizeTimestamp('nope')).toBeNull();
  });
});

describe('normalizeFailure', () => {
  it('extracts the money and the identifiers', () => {
    const f = normalizeFailure(CARD_FAILURE);
    expect(f.amount).toBe(184300);
    expect(f.currency).toBe('INR');
    expect(f.paymentId).toBe('pay_29QQoUBi66xm2f');
    expect(f.orderId).toBe('order_9A33XWu170gUtm');
    expect(f.customerEmail).toBe('rahul@example.com');
    expect(f.customerContact).toBe('+919876543210');
    expect(f.unrecognisedReason).toBe(false);
  });

  it('keeps the case alive when the amount is unparseable', () => {
    const f = normalizeFailure({ ...CARD_FAILURE, amount: 'not-a-number' });
    expect(f.amount).toBe(0);
    expect(f.orderId).toBe('order_9A33XWu170gUtm');
  });

  it('flags an unrecognised reason and preserves the original string', () => {
    const f = normalizeFailure({ ...CARD_FAILURE, error_reason: 'brand_new_code' });
    expect(f.unrecognisedReason).toBe(true);
    expect(f.rawReason).toBe('brand_new_code');
    expect(f.tuple.errorReason).toBe('unknown_reason');
  });

  it('finds a subscription id hiding in notes', () => {
    const f = normalizeFailure({ ...CARD_FAILURE, notes: { subscription_id: 'sub_123' } });
    expect(f.subscriptionId).toBe('sub_123');
  });
});
