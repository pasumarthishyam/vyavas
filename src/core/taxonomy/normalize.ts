/**
 * Raw Razorpay payment entity -> a clean, closed `ErrorTuple`.
 *
 * Scope boundary: core knows the shape of a Razorpay *payment entity*, which is
 * stable and documented. It does not know about webhook envelopes, HTTP, or
 * signatures — the adapter (Stage 4) unwraps `payload.payment.entity` and hands
 * the entity here.
 *
 * Everything is defensive. Razorpay adds fields and codes without notice, and a
 * payment gateway is not a place where throwing on an unexpected string is
 * acceptable behaviour: an unrecognised value must degrade into the most
 * cautious classification, never into a dropped case. Money at risk that we
 * failed to parse is still money at risk.
 */

import {
  type ErrorSource,
  type ErrorStep,
  type ErrorTuple,
  type PaymentMethod,
  ERROR_SOURCES,
  ERROR_STEPS,
  PAYMENT_METHODS,
} from '../case/types.js';
import { type Paise, paiseFromUnknown, ZERO_PAISE } from '../money.js';
import { descriptorFor, isKnownReason } from './codes.js';

/** The subset of a Razorpay payment entity we care about. All fields optional. */
export type RawPaymentEntity = Record<string, unknown>;

export interface NormalizedFailure {
  readonly tuple: ErrorTuple;
  readonly amount: Paise;
  readonly currency: string;
  readonly paymentId: string | null;
  readonly orderId: string | null;
  readonly invoiceId: string | null;
  readonly subscriptionId: string | null;
  readonly customerEmail: string | null;
  readonly customerContact: string | null;
  readonly vpa: string | null;
  readonly wallet: string | null;
  readonly createdAt: Date | null;
  /** Human-readable description from Razorpay. Never shown to customers verbatim. */
  readonly errorDescription: string | null;
  /** True when the reason was not in our taxonomy — triggers an internal alert. */
  readonly unrecognisedReason: boolean;
  /** The raw reason string as received, preserved for forensics. */
  readonly rawReason: string | null;
}

// ─── primitives ──────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function lower(v: unknown): string | null {
  const s = str(v);
  return s === null ? null : s.toLowerCase();
}

function pick(o: RawPaymentEntity, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const s = lower(value);
  if (s === null) return fallback;
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

// ─── field normalisers ───────────────────────────────────────────────────────

/**
 * Razorpay's `error_source` is not a closed enum in practice — we have seen
 * values outside the documented set. Unknown sources fall back to `'unknown'`,
 * which diagnose.ts treats as "do not use source to disambiguate", i.e. the
 * conservative path.
 */
export function normalizeSource(value: unknown): ErrorSource {
  const s = lower(value);
  if (s === null) return 'unknown';
  // Razorpay sometimes says "business" where our vocabulary says merchant.
  if (s === 'merchant') return 'business';
  return oneOf(s, ERROR_SOURCES, 'unknown');
}

export function normalizeStep(value: unknown): ErrorStep {
  const s = lower(value);
  if (s === null) return 'unknown';
  // Both spellings appear in the wild.
  if (s === 'payment_authorisation') return 'payment_authorization';
  if (s === 'payment_authentication' || s === 'authentication') return 'payment_authentication';
  return oneOf(s, ERROR_STEPS, 'unknown');
}

export function normalizeMethod(value: unknown): PaymentMethod {
  const s = lower(value);
  if (s === null) return 'unknown';
  if (s === 'card' || s === 'credit_card' || s === 'debit_card') return 'card';
  if (s === 'upi' || s === 'upi_intent' || s === 'upi_collect') return 'upi';
  if (s === 'netbanking' || s === 'net_banking') return 'netbanking';
  if (s === 'emi') return 'emi';
  if (s === 'cardless_emi') return 'cardless_emi';
  if (s === 'paylater' || s === 'pay_later') return 'paylater';
  if (s === 'bank_transfer') return 'bank_transfer';
  if (s === 'nach' || s === 'enach' || s === 'emandate') return 'nach';
  return oneOf(s, PAYMENT_METHODS, 'unknown');
}

/**
 * Bank identifiers are uppercase IFSC-style codes (HDFC, ICIC, UTIB...).
 * Normalising case matters because bank is a policy match dimension and a
 * downtime-feed join key — `hdfc` and `HDFC` must not be two different banks.
 */
export function normalizeBank(value: unknown): string | null {
  const s = str(value);
  return s === null ? null : s.toUpperCase();
}

export function normalizeNetwork(value: unknown): string | null {
  const s = str(value);
  return s === null ? null : s.toUpperCase();
}

/**
 * Razorpay timestamps are seconds since epoch, not milliseconds. Getting this
 * wrong silently places every case in 1970 and makes every deadline instantly
 * overdue, so the range is checked rather than assumed.
 */
export function normalizeTimestamp(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  // Anything below ~1e12 is plainly seconds; above that, already milliseconds.
  const ms = value < 1e12 ? value * 1000 : value;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─── the tuple ───────────────────────────────────────────────────────────────

export function normalizeErrorTuple(entity: RawPaymentEntity): ErrorTuple {
  const rawReason = lower(pick(entity, 'error_reason', 'errorReason'));
  const method = normalizeMethod(pick(entity, 'method'));

  // `bank` sits at the top level for netbanking, and inside `card` for cards.
  const card = (entity['card'] ?? {}) as RawPaymentEntity;
  const bank = normalizeBank(pick(entity, 'bank') ?? pick(card, 'issuer'));
  const network = normalizeNetwork(pick(card, 'network') ?? pick(entity, 'network'));

  return {
    errorCode: str(pick(entity, 'error_code', 'errorCode')),
    errorSource: normalizeSource(pick(entity, 'error_source', 'errorSource')),
    errorStep: normalizeStep(pick(entity, 'error_step', 'errorStep')),
    // Reasons we do not recognise are mapped to our `unknown_reason` bucket so
    // downstream code only ever meets closed values. The original string is
    // preserved on NormalizedFailure.rawReason.
    errorReason: rawReason !== null && isKnownReason(rawReason) ? rawReason : 'unknown_reason',
    method,
    bank,
    network,
  };
}

export function normalizeFailure(entity: RawPaymentEntity): NormalizedFailure {
  const tuple = normalizeErrorTuple(entity);
  const rawReason = lower(pick(entity, 'error_reason', 'errorReason'));

  let amount: Paise;
  try {
    const raw = pick(entity, 'amount');
    amount = raw === undefined ? ZERO_PAISE : paiseFromUnknown(raw);
  } catch {
    // A malformed amount must not lose the case. Zero flags it for review while
    // keeping the case alive; the workflow refetches the order before acting.
    amount = ZERO_PAISE;
  }

  const notes = (entity['notes'] ?? {}) as RawPaymentEntity;

  return {
    tuple,
    amount,
    currency: (str(pick(entity, 'currency')) ?? 'INR').toUpperCase(),
    paymentId: str(pick(entity, 'id', 'payment_id')),
    orderId: str(pick(entity, 'order_id', 'orderId')),
    invoiceId: str(pick(entity, 'invoice_id', 'invoiceId')),
    subscriptionId:
      str(pick(entity, 'subscription_id', 'subscriptionId')) ??
      str(pick(notes, 'subscription_id')),
    customerEmail: lower(pick(entity, 'email')),
    customerContact: str(pick(entity, 'contact')),
    vpa: lower(pick(entity, 'vpa')),
    wallet: lower(pick(entity, 'wallet')),
    createdAt: normalizeTimestamp(pick(entity, 'created_at', 'createdAt')),
    errorDescription: str(pick(entity, 'error_description', 'errorDescription')),
    unrecognisedReason: rawReason !== null && !isKnownReason(rawReason),
    rawReason,
  };
}

/** Convenience for merchant-facing UI — never used to compose customer copy. */
export function describeFailure(tuple: ErrorTuple): string {
  return descriptorFor(tuple.errorReason ?? 'unknown_reason').meaning;
}
