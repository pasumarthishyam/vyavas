/**
 * The golden fixtures.
 *
 * One entry per documented Razorpay failure reason, plus scenario fixtures for
 * the context-dependent behaviour (live downtime, attempt history, mandates).
 *
 * An exhaustiveness test fails CI if any reason in codes.ts lacks a fixture
 * here. That test is the whole point: it is what stops this taxonomy quietly
 * degrading into "we handle a dozen codes properly and everything else gets a
 * generic email", which is the state of every dunning tool on the market.
 */

import type { AlternateRail, CaseType, ErrorTuple, PaymentMethod } from '@core/case/types.js';
import type { CauseClass } from '@core/taxonomy/cause-class.js';
import type { Confidence, DiagnoseContext, DowntimeWindow } from '@core/taxonomy/diagnose.js';
import type { ErrorReason } from '@core/taxonomy/codes.js';
import { paise } from '@core/money.js';

/** Every fixture is evaluated at this instant. Nothing in core reads a clock. */
export const FIXED_NOW = new Date('2026-08-27T14:10:00.000Z');

export function makeTuple(over: Partial<ErrorTuple> = {}): ErrorTuple {
  return {
    errorCode: 'BAD_REQUEST_ERROR',
    errorSource: 'customer',
    errorStep: 'payment_authorization',
    errorReason: 'payment_failed',
    method: 'card' as PaymentMethod,
    bank: 'HDFC',
    network: 'VISA',
    ...over,
  };
}

export function makeCtx(over: Partial<DiagnoseContext> = {}): DiagnoseContext {
  return {
    now: FIXED_NOW,
    caseType: 'payment_failure' as CaseType,
    amount: paise(184300), // Rs 1,843
    hasMandate: false,
    activeDowntime: [],
    priorAttempts: [],
    ...over,
  };
}

export const HDFC_CARD_OUTAGE: DowntimeWindow = {
  method: 'card',
  bank: 'HDFC',
  network: null,
  severity: 'high',
  startedAt: new Date('2026-08-27T13:30:00.000Z'),
};

export const ICICI_NETBANKING_OUTAGE: DowntimeWindow = {
  method: 'netbanking',
  bank: 'ICIC',
  network: null,
  severity: 'high',
  startedAt: new Date('2026-08-27T13:30:00.000Z'),
};

export interface Expectation {
  readonly causeClass: CauseClass;
  readonly caseType?: CaseType;
  readonly attended?: boolean;
  readonly sameInstrumentRetry?: boolean;
  readonly contactCustomer?: boolean;
  readonly alertMerchant?: boolean;
  readonly shouldAbort?: boolean;
  readonly maxCustomerTouches?: number;
  readonly minFirstTouchMinutes?: number;
  readonly downtimeGated?: boolean;
  readonly confidence?: Confidence;
  /** Exact rail list, in order. */
  readonly rails?: readonly AlternateRail[];
  readonly railsInclude?: readonly AlternateRail[];
  readonly railsExclude?: readonly AlternateRail[];
}

export interface GoldenCase {
  readonly name: string;
  /** Which reason this fixture covers, for the exhaustiveness check. */
  readonly covers: ErrorReason;
  readonly tuple: Partial<ErrorTuple>;
  readonly ctx?: Partial<DiagnoseContext>;
  readonly expect: Expectation;
}

const g = (c: GoldenCase) => c;

// ─── A · Transient infrastructure ────────────────────────────────────────────

const TRANSIENT: readonly GoldenCase[] = [
  g({
    name: 'bank_technical_error — the bank fell over; the card is fine',
    covers: 'bank_technical_error',
    tuple: { errorReason: 'bank_technical_error', errorSource: 'bank' },
    expect: {
      causeClass: 'transient_infra',
      sameInstrumentRetry: true,
      // Never message inside 20 minutes: the bank is probably still down and a
      // nudge now walks the customer into a second failure.
      minFirstTouchMinutes: 20,
      railsInclude: ['upi_intent'],
    },
  }),
  g({
    name: 'gateway_technical_error — partner gateway downtime',
    covers: 'gateway_technical_error',
    tuple: { errorReason: 'gateway_technical_error', errorSource: 'gateway' },
    expect: { causeClass: 'transient_infra', sameInstrumentRetry: true },
  }),
  g({
    name: 'bank_not_available',
    covers: 'bank_not_available',
    tuple: { errorReason: 'bank_not_available', errorSource: 'gateway', method: 'netbanking' },
    expect: { causeClass: 'transient_infra', railsInclude: ['upi_intent'] },
  }),
  g({
    name: 'bank_cutoff_in_progress — nightly CBS window, deterministically time-bound',
    covers: 'bank_cutoff_in_progress',
    tuple: { errorReason: 'bank_cutoff_in_progress', errorSource: 'bank', method: 'netbanking' },
    expect: { causeClass: 'transient_infra', downtimeGated: true },
  }),
  g({
    name: 'authorisation_declined_by_psp on UPI — PSP declines are overwhelmingly transient',
    covers: 'authorisation_declined_by_psp',
    tuple: {
      errorReason: 'authorisation_declined_by_psp',
      errorSource: 'gateway',
      method: 'upi',
      bank: null,
      network: null,
    },
    expect: { causeClass: 'transient_infra', confidence: 'high' },
  }),
];

// ─── B · Instrument unusable ─────────────────────────────────────────────────

const INSTRUMENT_DEAD: readonly GoldenCase[] = [
  g({
    name: 'card_expired — never re-present; ask for a different method',
    covers: 'card_expired',
    tuple: { errorReason: 'card_expired' },
    expect: {
      causeClass: 'instrument_dead',
      sameInstrumentRetry: false,
      // Short but non-zero: an upstream live-attempt lock keeps us from
      // interrupting someone already mid-retry on another card.
      minFirstTouchMinutes: 3,
      rails: ['upi_intent', 'other_card', 'netbanking'],
      railsExclude: ['retry_same'],
    },
  }),
  g({
    name: 'debit_instrument_blocked',
    covers: 'debit_instrument_blocked',
    tuple: { errorReason: 'debit_instrument_blocked' },
    expect: { causeClass: 'instrument_dead', sameInstrumentRetry: false },
  }),
  g({
    name: 'debit_instrument_inactive',
    covers: 'debit_instrument_inactive',
    tuple: { errorReason: 'debit_instrument_inactive' },
    expect: { causeClass: 'instrument_dead', sameInstrumentRetry: false },
  }),
  g({
    name: 'card_not_enrolled — huge on Indian debit cards; needs education, not an apology',
    covers: 'card_not_enrolled',
    tuple: { errorReason: 'card_not_enrolled' },
    expect: { causeClass: 'instrument_dead', sameInstrumentRetry: false },
  }),
  g({
    name: 'card_disabled_for_online_payments — fixable by the customer in their bank app',
    covers: 'card_disabled_for_online_payments',
    tuple: { errorReason: 'card_disabled_for_online_payments' },
    expect: { causeClass: 'instrument_dead', sameInstrumentRetry: false },
  }),
  g({
    name: 'bank_account_invalid',
    covers: 'bank_account_invalid',
    tuple: { errorReason: 'bank_account_invalid', method: 'netbanking', errorSource: 'bank' },
    expect: { causeClass: 'instrument_dead', sameInstrumentRetry: false },
  }),
  g({
    name: 'bank_account_validation_failed',
    covers: 'bank_account_validation_failed',
    tuple: {
      errorReason: 'bank_account_validation_failed',
      method: 'bank_transfer',
      errorSource: 'bank',
    },
    expect: { causeClass: 'instrument_dead', sameInstrumentRetry: false },
  }),
  g({
    name: 'invalid_vpa from the bank — a dead handle, never answered with UPI collect',
    covers: 'invalid_vpa',
    tuple: {
      errorReason: 'invalid_vpa',
      errorSource: 'bank',
      method: 'upi',
      bank: null,
      network: null,
    },
    expect: {
      causeClass: 'instrument_dead',
      sameInstrumentRetry: false,
      // Suggesting UPI collect would send a request to the very handle that
      // just failed; suggesting UPI intent asks them to use a broken VPA.
      railsExclude: ['upi_collect', 'upi_intent', 'retry_same'],
      railsInclude: ['other_card'],
    },
  }),
];

// ─── C · Customer input ──────────────────────────────────────────────────────

const CUSTOMER_INPUT: readonly GoldenCase[] = [
  g({
    name: 'incorrect_cvv — a typo, and the customer is right there',
    covers: 'incorrect_cvv',
    tuple: { errorReason: 'incorrect_cvv', errorSource: 'customer' },
    expect: {
      causeClass: 'customer_input',
      sameInstrumentRetry: true,
      minFirstTouchMinutes: 0, // intent decays in minutes; act in-session
      railsInclude: ['retry_same'],
    },
  }),
  g({
    name: 'incorrect_card_details',
    covers: 'incorrect_card_details',
    tuple: { errorReason: 'incorrect_card_details', errorSource: 'customer' },
    expect: { causeClass: 'customer_input', minFirstTouchMinutes: 0 },
  }),
  g({
    name: 'incorrect_card_expiry_date — distinct from card_expired: the card is fine',
    covers: 'incorrect_card_expiry_date',
    tuple: { errorReason: 'incorrect_card_expiry_date', errorSource: 'customer' },
    expect: { causeClass: 'customer_input', sameInstrumentRetry: true },
  }),
  g({
    name: 'incorrect_cardholder_name',
    covers: 'incorrect_cardholder_name',
    tuple: { errorReason: 'incorrect_cardholder_name', errorSource: 'customer' },
    expect: { causeClass: 'customer_input' },
  }),
  g({
    name: 'incorrect_otp — usually a late SMS rather than a typo',
    covers: 'incorrect_otp',
    tuple: { errorReason: 'incorrect_otp', errorSource: 'customer' },
    expect: { causeClass: 'customer_input', sameInstrumentRetry: true },
  }),
  g({
    name: 'incorrect_pin',
    covers: 'incorrect_pin',
    tuple: { errorReason: 'incorrect_pin', errorSource: 'customer', method: 'upi' },
    expect: { causeClass: 'customer_input' },
  }),
  g({
    name: 'incorrect_atm_pin',
    covers: 'incorrect_atm_pin',
    tuple: { errorReason: 'incorrect_atm_pin', errorSource: 'customer', method: 'upi' },
    expect: { causeClass: 'customer_input' },
  }),
  g({
    name: 'mobile_number_invalid from the customer',
    covers: 'mobile_number_invalid',
    tuple: { errorReason: 'mobile_number_invalid', errorSource: 'customer' },
    expect: { causeClass: 'customer_input', confidence: 'high' },
  }),
  g({
    name: 'invalid_user_details from the customer',
    covers: 'invalid_user_details',
    tuple: { errorReason: 'invalid_user_details', errorSource: 'customer' },
    expect: { causeClass: 'customer_input' },
  }),
];

// ─── D · Authentication friction ─────────────────────────────────────────────

const AUTH_FRICTION: readonly GoldenCase[] = [
  g({
    name: 'authentication_failed from the customer — a wrong OTP, i.e. a typo',
    covers: 'authentication_failed',
    tuple: { errorReason: 'authentication_failed', errorSource: 'customer' },
    expect: { causeClass: 'customer_input', confidence: 'high' },
  }),
  g({
    name: 'payment_timed_out — often a slow bank 3DS page, not an inattentive customer',
    covers: 'payment_timed_out',
    tuple: { errorReason: 'payment_timed_out', errorSource: 'gateway' },
    expect: { causeClass: 'auth_friction', sameInstrumentRetry: true },
  }),
];

// ─── E · Funds and limits ────────────────────────────────────────────────────

const FUNDS_LIMITS: readonly GoldenCase[] = [
  g({
    name: 'insufficient_funds — timing is the entire lever',
    covers: 'insufficient_funds',
    tuple: { errorReason: 'insufficient_funds', errorSource: 'bank' },
    expect: {
      causeClass: 'funds_limits',
      sameInstrumentRetry: true,
      minFirstTouchMinutes: 180,
      railsInclude: ['upi_intent', 'other_card'],
      // Rs 1,843 is below any plausible EMI floor.
      railsExclude: ['emi'],
    },
  }),
  g({
    name: 'insufficient_funds on a large ticket — EMI becomes a real answer',
    covers: 'insufficient_funds',
    tuple: { errorReason: 'insufficient_funds', errorSource: 'bank' },
    ctx: { amount: paise(4500000) }, // Rs 45,000
    expect: { causeClass: 'funds_limits', railsInclude: ['emi'] },
  }),
  g({
    name: 'transaction_limit_exceeded — daily limits reset at midnight',
    covers: 'transaction_limit_exceeded',
    tuple: { errorReason: 'transaction_limit_exceeded', errorSource: 'bank' },
    expect: { causeClass: 'funds_limits', sameInstrumentRetry: true },
  }),
  g({
    name: 'emi_greater_than_max_amount',
    covers: 'emi_greater_than_max_amount',
    tuple: { errorReason: 'emi_greater_than_max_amount', method: 'emi', errorSource: 'bank' },
    expect: { causeClass: 'funds_limits' },
  }),
  g({
    name: 'emi_plan_unavailable',
    covers: 'emi_plan_unavailable',
    tuple: { errorReason: 'emi_plan_unavailable', method: 'emi', errorSource: 'bank' },
    expect: { causeClass: 'funds_limits' },
  }),
];

// ─── F · Risk ────────────────────────────────────────────────────────────────

const RISK: readonly GoldenCase[] = [
  g({
    name: 'payment_risk_check_failed — one alternate rail, then stop',
    covers: 'payment_risk_check_failed',
    tuple: { errorReason: 'payment_risk_check_failed', errorSource: 'bank' },
    expect: {
      causeClass: 'risk',
      // Re-presenting raises the risk score, can block the card, and degrades
      // the merchant's overall auth rate. One touch only.
      sameInstrumentRetry: false,
      maxCustomerTouches: 1,
      rails: ['upi_intent'],
    },
  }),
  g({
    name: 'card_declined at authorisation — read conservatively as risk',
    covers: 'card_declined',
    tuple: {
      errorReason: 'card_declined',
      errorSource: 'issuer',
      errorStep: 'payment_authorization',
    },
    expect: { causeClass: 'risk', sameInstrumentRetry: false, maxCustomerTouches: 1 },
  }),
  g({
    name: 'mismatch_in_transaction_details from the bank',
    covers: 'mismatch_in_transaction_details',
    tuple: { errorReason: 'mismatch_in_transaction_details', errorSource: 'bank' },
    expect: { causeClass: 'risk', sameInstrumentRetry: false },
  }),
];

// ─── G · Merchant configuration ──────────────────────────────────────────────

const MERCHANT_CONFIG: readonly GoldenCase[] = [
  g({
    name: 'bank_not_enabled from the merchant — every customer on this path is a total loss',
    covers: 'bank_not_enabled',
    tuple: { errorReason: 'bank_not_enabled', errorSource: 'business', method: 'netbanking' },
    expect: {
      causeClass: 'merchant_config',
      alertMerchant: true,
      // The customer is not at fault and is still rescued onto a working rail.
      contactCustomer: true,
      railsInclude: ['upi_intent'],
    },
  }),
  g({
    name: 'live_mode_not_enabled',
    covers: 'live_mode_not_enabled',
    tuple: { errorReason: 'live_mode_not_enabled', errorSource: 'business' },
    expect: { causeClass: 'merchant_config', alertMerchant: true },
  }),
  g({
    name: 'merchant_not_activated',
    covers: 'merchant_not_activated',
    tuple: { errorReason: 'merchant_not_activated', errorSource: 'business' },
    expect: { causeClass: 'merchant_config', alertMerchant: true },
  }),
  g({
    name: 'order_payment_method_mismatch',
    covers: 'order_payment_method_mismatch',
    tuple: { errorReason: 'order_payment_method_mismatch', errorSource: 'business' },
    expect: { causeClass: 'merchant_config', alertMerchant: true },
  }),
  g({
    name: 'input_validation_failed from the integration',
    covers: 'input_validation_failed',
    tuple: { errorReason: 'input_validation_failed', errorSource: 'business' },
    expect: { causeClass: 'merchant_config', alertMerchant: true, confidence: 'high' },
  }),
  g({
    name: 'invalid_request',
    covers: 'invalid_request',
    tuple: { errorReason: 'invalid_request', errorSource: 'business' },
    expect: { causeClass: 'merchant_config', alertMerchant: true },
  }),
  g({
    name: 'amount_less_than_minimum_amount — feels like a limit, is a merchant config fault',
    covers: 'amount_less_than_minimum_amount',
    tuple: { errorReason: 'amount_less_than_minimum_amount', errorSource: 'business' },
    expect: { causeClass: 'merchant_config', alertMerchant: true },
  }),
];

// ─── H · Terminal / no-op ────────────────────────────────────────────────────

const TERMINAL: readonly GoldenCase[] = [
  g({
    name: 'order_already_paid — close everything; never contact this customer',
    covers: 'order_already_paid',
    tuple: { errorReason: 'order_already_paid', errorSource: 'business' },
    expect: {
      causeClass: 'terminal_noop',
      shouldAbort: true,
      contactCustomer: false,
      maxCustomerTouches: 0,
      rails: [],
    },
  }),
  g({
    name: 'duplicate_request',
    covers: 'duplicate_request',
    tuple: { errorReason: 'duplicate_request', errorSource: 'business' },
    expect: { causeClass: 'terminal_noop', shouldAbort: true, contactCustomer: false },
  }),
  g({
    name: 'duplicate_refund_id — refund-side, no revenue at risk',
    covers: 'duplicate_refund_id',
    tuple: { errorReason: 'duplicate_refund_id', errorSource: 'business' },
    expect: { causeClass: 'terminal_noop', shouldAbort: true, contactCustomer: false },
  }),
];

// ─── I · Deliberate exit ─────────────────────────────────────────────────────

const INTENT_EXIT: readonly GoldenCase[] = [
  g({
    name: 'payment_cancelled — a choice, not a malfunction; re-typed as intent_exit',
    covers: 'payment_cancelled',
    tuple: { errorReason: 'payment_cancelled', errorSource: 'customer' },
    ctx: { caseType: 'payment_failure' },
    expect: {
      causeClass: 'intent_exit',
      // The architectural separation: this can never wear failure language and
      // never counts toward failure-rate alerting.
      caseType: 'intent_exit',
      minFirstTouchMinutes: 20,
      railsInclude: ['upi_intent', 'retry_same'],
    },
  }),
];

// ─── Generic / unknown ───────────────────────────────────────────────────────

const GENERIC: readonly GoldenCase[] = [
  g({
    name: 'payment_failed from the bank — the long tail, classified conservatively',
    covers: 'payment_failed',
    tuple: { errorReason: 'payment_failed', errorSource: 'bank' },
    expect: { causeClass: 'transient_infra', confidence: 'medium' },
  }),
  g({
    name: 'unknown_reason — an undocumented code must never drop the case',
    covers: 'unknown_reason',
    tuple: { errorReason: 'unknown_reason', errorSource: 'unknown' },
    expect: { causeClass: 'transient_infra', confidence: 'low' },
  }),
];

// ─── Context-dependent scenarios ─────────────────────────────────────────────

const SCENARIOS: readonly GoldenCase[] = [
  g({
    name: 'DOWNTIME: card_declined during a confirmed HDFC card outage is an outage, not a risk decline',
    covers: 'card_declined',
    tuple: {
      errorReason: 'card_declined',
      errorSource: 'issuer',
      errorStep: 'payment_authorization',
      bank: 'HDFC',
      method: 'card',
    },
    ctx: { activeDowntime: [HDFC_CARD_OUTAGE] },
    expect: {
      causeClass: 'transient_infra',
      downtimeGated: true,
      // The instrument is fine — so re-presenting once the bank is back is
      // exactly the right move, where a risk decline would forbid it.
      sameInstrumentRetry: true,
    },
  }),
  g({
    name: 'DOWNTIME: an expired card is still expired during an outage — no reclassification',
    covers: 'card_expired',
    tuple: { errorReason: 'card_expired', bank: 'HDFC', method: 'card' },
    ctx: { activeDowntime: [HDFC_CARD_OUTAGE] },
    expect: {
      causeClass: 'instrument_dead',
      downtimeGated: false,
      sameInstrumentRetry: false,
    },
  }),
  g({
    name: 'DOWNTIME: a typo is still a typo during an outage',
    covers: 'incorrect_cvv',
    tuple: { errorReason: 'incorrect_cvv', errorSource: 'customer', bank: 'HDFC' },
    ctx: { activeDowntime: [HDFC_CARD_OUTAGE] },
    expect: { causeClass: 'customer_input', downtimeGated: false },
  }),
  g({
    name: 'DOWNTIME: an outage on a different bank does not apply',
    covers: 'bank_technical_error',
    tuple: { errorReason: 'bank_technical_error', bank: 'HDFC', method: 'netbanking' },
    ctx: { activeDowntime: [ICICI_NETBANKING_OUTAGE] },
    expect: { causeClass: 'transient_infra' },
  }),

  g({
    name: 'ATTEMPTS: a third wrong OTP would lock the card — withdraw same-instrument retry',
    covers: 'incorrect_otp',
    tuple: { errorReason: 'incorrect_otp', errorSource: 'customer', method: 'card' },
    ctx: {
      priorAttempts: [
        { at: new Date('2026-08-27T14:00:00Z'), method: 'card', errorReason: 'incorrect_otp' },
        { at: new Date('2026-08-27T14:05:00Z'), method: 'card', errorReason: 'incorrect_otp' },
      ],
    },
    expect: {
      causeClass: 'customer_input',
      sameInstrumentRetry: false,
      railsExclude: ['retry_same'],
      railsInclude: ['upi_intent'],
    },
  }),
  g({
    name: 'ATTEMPTS: one prior wrong OTP still permits a same-method retry',
    covers: 'incorrect_otp',
    tuple: { errorReason: 'incorrect_otp', errorSource: 'customer', method: 'card' },
    ctx: {
      priorAttempts: [
        { at: new Date('2026-08-27T14:00:00Z'), method: 'card', errorReason: 'incorrect_otp' },
      ],
    },
    expect: { causeClass: 'customer_input', sameInstrumentRetry: true },
  }),
  g({
    name: 'ATTEMPTS: attempts on a different reason do not count against this one',
    covers: 'incorrect_cvv',
    tuple: { errorReason: 'incorrect_cvv', errorSource: 'customer', method: 'card' },
    ctx: {
      priorAttempts: [
        { at: new Date('2026-08-27T14:00:00Z'), method: 'card', errorReason: 'incorrect_otp' },
        { at: new Date('2026-08-27T14:02:00Z'), method: 'card', errorReason: 'incorrect_otp' },
        { at: new Date('2026-08-27T14:04:00Z'), method: 'card', errorReason: 'incorrect_otp' },
      ],
    },
    expect: { causeClass: 'customer_input', sameInstrumentRetry: true },
  }),

  g({
    name: 'MANDATE: a subscription debit with a live mandate is unattended',
    covers: 'insufficient_funds',
    tuple: { errorReason: 'insufficient_funds', errorSource: 'bank' },
    ctx: { caseType: 'subscription_failure', hasMandate: true },
    expect: { causeClass: 'funds_limits', attended: false },
  }),
  g({
    name: 'MANDATE: a dead instrument makes the mandate dead too — attended re-registration',
    covers: 'card_expired',
    tuple: { errorReason: 'card_expired' },
    ctx: { caseType: 'subscription_failure', hasMandate: true },
    expect: {
      causeClass: 'instrument_dead',
      // Re-presenting against a mandate whose card has expired burns attempts
      // against something that can never succeed. Needs AFA re-registration.
      attended: true,
      sameInstrumentRetry: false,
    },
  }),
  g({
    name: 'MANDATE: no mandate always means attended — there is no lawful silent retry in India',
    covers: 'insufficient_funds',
    tuple: { errorReason: 'insufficient_funds', errorSource: 'bank' },
    ctx: { caseType: 'subscription_failure', hasMandate: false },
    expect: { causeClass: 'funds_limits', attended: true },
  }),
  g({
    name: 'MANDATE: a one-off order stays attended even when the payer has a mandate',
    covers: 'insufficient_funds',
    tuple: { errorReason: 'insufficient_funds', errorSource: 'bank' },
    ctx: { caseType: 'payment_failure', hasMandate: true },
    expect: { causeClass: 'funds_limits', attended: true },
  }),

  g({
    name: 'SOURCE: authentication_failed from the gateway is infrastructure, not a typo',
    covers: 'authentication_failed',
    tuple: { errorReason: 'authentication_failed', errorSource: 'gateway' },
    expect: { causeClass: 'auth_friction', confidence: 'high' },
  }),
  g({
    name: 'SOURCE: bank_not_enabled from the gateway is a delisting, not a merchant fault',
    covers: 'bank_not_enabled',
    tuple: { errorReason: 'bank_not_enabled', errorSource: 'gateway', method: 'netbanking' },
    expect: { causeClass: 'transient_infra', alertMerchant: true },
  }),
  g({
    name: 'SOURCE: invalid_vpa from the customer is a typo, not a dead handle',
    covers: 'invalid_vpa',
    tuple: { errorReason: 'invalid_vpa', errorSource: 'customer', method: 'upi' },
    expect: {
      causeClass: 'customer_input',
      sameInstrumentRetry: true,
      railsInclude: ['retry_same'],
      railsExclude: ['upi_collect'],
    },
  }),
  g({
    name: 'SOURCE: mobile_number_invalid from the merchant is a config fault',
    covers: 'mobile_number_invalid',
    tuple: { errorReason: 'mobile_number_invalid', errorSource: 'business' },
    expect: { causeClass: 'merchant_config', alertMerchant: true },
  }),
  g({
    name: 'SOURCE: payment_failed attributed to the merchant is a config fault',
    covers: 'payment_failed',
    tuple: { errorReason: 'payment_failed', errorSource: 'business' },
    expect: { causeClass: 'merchant_config', alertMerchant: true },
  }),
  g({
    name: 'SOURCE: authorisation_declined_by_psp from the issuer reads as risk',
    covers: 'authorisation_declined_by_psp',
    tuple: {
      errorReason: 'authorisation_declined_by_psp',
      errorSource: 'issuer',
      method: 'card',
    },
    expect: { causeClass: 'risk', sameInstrumentRetry: false, maxCustomerTouches: 1 },
  }),
];

export const GOLDEN_CASES: readonly GoldenCase[] = [
  ...TRANSIENT,
  ...INSTRUMENT_DEAD,
  ...CUSTOMER_INPUT,
  ...AUTH_FRICTION,
  ...FUNDS_LIMITS,
  ...RISK,
  ...MERCHANT_CONFIG,
  ...TERMINAL,
  ...INTENT_EXIT,
  ...GENERIC,
  ...SCENARIOS,
];
