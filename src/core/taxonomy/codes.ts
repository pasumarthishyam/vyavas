/**
 * Every documented Razorpay failure reason, in one place.
 *
 * Razorpay publishes these across three overlapping lists — general payment
 * errors, card-specific errors, and gateway errors. Several reasons appear in
 * more than one list with different meanings depending on where they surfaced,
 * which is exactly why `error_reason` alone is not a usable key. Each entry
 * below records which lists it belongs to, and whether resolving it correctly
 * requires `error_source` / `error_step`.
 *
 * `baseCauseClass` is the classification when we have nothing but the reason.
 * `diagnose.ts` refines it using the full tuple plus live context (downtime,
 * attempt history, mandate presence). For reasons flagged
 * `requiresSourceDisambiguation`, the base class is a fallback we expect to be
 * overridden — a golden test asserts each of those has at least one refining rule.
 */

import type { CauseClass } from './cause-class.js';

export const RAZORPAY_ERROR_LISTS = ['general', 'card', 'gateway'] as const;
export type RazorpayErrorList = (typeof RAZORPAY_ERROR_LISTS)[number];

export interface ErrorReasonDescriptor {
  readonly reason: string;
  /** Which of Razorpay's published lists this reason appears in. */
  readonly lists: readonly RazorpayErrorList[];
  /** Plain-language meaning, for merchant-facing UI and message generation. */
  readonly meaning: string;
  readonly baseCauseClass: CauseClass;
  /**
   * True when the same reason means materially different things depending on
   * `error_source` or `error_step`, and must not be classified on reason alone.
   */
  readonly requiresSourceDisambiguation: boolean;
  /** Why it maps where it does — kept next to the mapping so it stays true. */
  readonly note?: string;
}

const D = (d: ErrorReasonDescriptor) => d;

export const ERROR_REASONS = {
  // ─── A · Transient infrastructure ──────────────────────────────────────────

  bank_technical_error: D({
    reason: 'bank_technical_error',
    lists: ['general', 'card', 'gateway'],
    meaning: "The customer's bank had a technical problem.",
    baseCauseClass: 'transient_infra',
    requiresSourceDisambiguation: false,
    note: 'Appears in all three lists. Prime candidate for downtime-feed gating rather than a blind timer.',
  }),

  gateway_technical_error: D({
    reason: 'gateway_technical_error',
    lists: ['card', 'gateway'],
    meaning: 'The partner bank or gateway had technical downtime.',
    baseCauseClass: 'transient_infra',
    requiresSourceDisambiguation: false,
  }),

  bank_not_available: D({
    reason: 'bank_not_available',
    lists: ['gateway'],
    meaning: 'The bank was unavailable.',
    baseCauseClass: 'transient_infra',
    requiresSourceDisambiguation: false,
  }),

  bank_cutoff_in_progress: D({
    reason: 'bank_cutoff_in_progress',
    lists: ['gateway'],
    meaning: "The bank's core banking system is in its nightly cutoff window.",
    baseCauseClass: 'transient_infra',
    requiresSourceDisambiguation: false,
    note: 'Deterministically time-bound. Park past the window; never message during it — it is the middle of the night.',
  }),

  authorisation_declined_by_psp: D({
    reason: 'authorisation_declined_by_psp',
    lists: ['gateway'],
    meaning: 'The PSP rejected the authorisation.',
    baseCauseClass: 'transient_infra',
    requiresSourceDisambiguation: true,
    note: 'Ambiguous by design. From a UPI PSP it is usually transient; where risk is indicated it must be treated as a risk decline.',
  }),

  // ─── B · Instrument unusable ───────────────────────────────────────────────

  card_expired: D({
    reason: 'card_expired',
    lists: ['card'],
    meaning: 'The card has expired.',
    baseCauseClass: 'instrument_dead',
    requiresSourceDisambiguation: false,
  }),

  debit_instrument_blocked: D({
    reason: 'debit_instrument_blocked',
    lists: ['card'],
    meaning: 'The card has been blocked.',
    baseCauseClass: 'instrument_dead',
    requiresSourceDisambiguation: false,
  }),

  debit_instrument_inactive: D({
    reason: 'debit_instrument_inactive',
    lists: ['card'],
    meaning: 'The card or instrument is not active.',
    baseCauseClass: 'instrument_dead',
    requiresSourceDisambiguation: false,
  }),

  card_not_enrolled: D({
    reason: 'card_not_enrolled',
    lists: ['card'],
    meaning: 'The card is not enabled or activated for online transactions.',
    baseCauseClass: 'instrument_dead',
    requiresSourceDisambiguation: false,
    note: 'Very high volume on Indian debit cards. Needs an educational message plus a UPI escape hatch — a generic retry prompt is useless here.',
  }),

  card_disabled_for_online_payments: D({
    reason: 'card_disabled_for_online_payments',
    lists: ['card'],
    meaning: 'Online transactions are switched off on this card.',
    baseCauseClass: 'instrument_dead',
    requiresSourceDisambiguation: false,
    note: 'Fixable by the customer in their banking app — so say that, explicitly, and offer UPI meanwhile.',
  }),

  bank_account_invalid: D({
    reason: 'bank_account_invalid',
    lists: ['general'],
    meaning: 'The bank account is invalid or closed.',
    baseCauseClass: 'instrument_dead',
    requiresSourceDisambiguation: false,
  }),

  bank_account_validation_failed: D({
    reason: 'bank_account_validation_failed',
    lists: ['general'],
    meaning: 'Bank-account validation failed.',
    baseCauseClass: 'instrument_dead',
    requiresSourceDisambiguation: false,
  }),

  invalid_vpa: D({
    reason: 'invalid_vpa',
    lists: ['general'],
    meaning: 'The UPI VPA is invalid.',
    baseCauseClass: 'instrument_dead',
    requiresSourceDisambiguation: true,
    note: 'A mistyped VPA is a customer_input typo; a VPA that no longer exists is a dead instrument. Source decides.',
  }),

  // ─── C · Customer input ────────────────────────────────────────────────────

  incorrect_cvv: D({
    reason: 'incorrect_cvv',
    lists: ['general', 'card'],
    meaning: 'The CVV entered did not match the card.',
    baseCauseClass: 'customer_input',
    requiresSourceDisambiguation: false,
  }),

  incorrect_card_details: D({
    reason: 'incorrect_card_details',
    lists: ['general'],
    meaning: 'Incorrect card information.',
    baseCauseClass: 'customer_input',
    requiresSourceDisambiguation: false,
  }),

  incorrect_card_expiry_date: D({
    reason: 'incorrect_card_expiry_date',
    lists: ['general'],
    meaning: 'Incorrect card expiry date entered.',
    baseCauseClass: 'customer_input',
    requiresSourceDisambiguation: false,
    note: 'Distinct from card_expired: the card is fine, the typing was not.',
  }),

  incorrect_cardholder_name: D({
    reason: 'incorrect_cardholder_name',
    lists: ['general'],
    meaning: 'Incorrect cardholder name.',
    baseCauseClass: 'customer_input',
    requiresSourceDisambiguation: false,
  }),

  incorrect_otp: D({
    reason: 'incorrect_otp',
    lists: ['general'],
    meaning: 'The OTP entered was wrong or had already expired.',
    baseCauseClass: 'customer_input',
    requiresSourceDisambiguation: false,
    note: 'Usually a late SMS rather than a typo. Allow one same-method retry, then switch rails — three wrong OTPs commonly locks the card at the issuer.',
  }),

  incorrect_pin: D({
    reason: 'incorrect_pin',
    lists: ['general'],
    meaning: 'The PIN entered was rejected by the bank.',
    baseCauseClass: 'customer_input',
    requiresSourceDisambiguation: false,
  }),

  incorrect_atm_pin: D({
    reason: 'incorrect_atm_pin',
    lists: ['general'],
    meaning: 'Incorrect ATM PIN.',
    baseCauseClass: 'customer_input',
    requiresSourceDisambiguation: false,
    note: 'On UPI, repeated wrong PINs lock the handle at NPCI. Cap attempts hard.',
  }),

  mobile_number_invalid: D({
    reason: 'mobile_number_invalid',
    lists: ['general'],
    meaning: 'Invalid mobile number.',
    baseCauseClass: 'customer_input',
    requiresSourceDisambiguation: true,
    note: 'From the customer it is a typo. From the merchant it is a bad API payload — and it also means SMS is undeliverable, so channel selection must drop SMS.',
  }),

  invalid_user_details: D({
    reason: 'invalid_user_details',
    lists: ['general'],
    meaning: 'Invalid customer details.',
    baseCauseClass: 'customer_input',
    requiresSourceDisambiguation: true,
  }),

  // ─── D · Authentication friction ───────────────────────────────────────────

  authentication_failed: D({
    reason: 'authentication_failed',
    lists: ['general', 'card', 'gateway'],
    meaning: '3DS / OTP authentication failed.',
    baseCauseClass: 'auth_friction',
    requiresSourceDisambiguation: true,
    note: 'The clearest example of why reason alone is not a key. source=customer is a recoverable typo; source=gateway/bank is infrastructure.',
  }),

  payment_timed_out: D({
    reason: 'payment_timed_out',
    lists: ['card', 'gateway'],
    meaning: 'The customer exceeded the payment time limit.',
    baseCauseClass: 'auth_friction',
    requiresSourceDisambiguation: false,
    note: 'In India this is very often a slow bank 3DS page rather than an inattentive customer.',
  }),

  // ─── E · Funds and limits ──────────────────────────────────────────────────

  insufficient_funds: D({
    reason: 'insufficient_funds',
    lists: ['card'],
    meaning: 'Insufficient funds in the account or on the card.',
    baseCauseClass: 'funds_limits',
    requiresSourceDisambiguation: false,
    note: 'Salary-cycle aware scheduling belongs here, not a fixed backoff.',
  }),

  transaction_limit_exceeded: D({
    reason: 'transaction_limit_exceeded',
    lists: ['card'],
    meaning: "The card's transaction limit has been reached.",
    baseCauseClass: 'funds_limits',
    requiresSourceDisambiguation: false,
    note: 'Daily limits reset at midnight local time — one of the few genuinely deterministic retry windows we get.',
  }),

  amount_less_than_minimum_amount: D({
    reason: 'amount_less_than_minimum_amount',
    lists: ['general'],
    meaning: 'The payment amount is below the permitted minimum.',
    baseCauseClass: 'merchant_config',
    requiresSourceDisambiguation: false,
    note: 'Filed under funds/limits by intuition, but it is a merchant configuration fault. The customer cannot fix it and must not be told to.',
  }),

  emi_greater_than_max_amount: D({
    reason: 'emi_greater_than_max_amount',
    lists: ['general'],
    meaning: 'The EMI amount exceeds the allowed maximum.',
    baseCauseClass: 'funds_limits',
    requiresSourceDisambiguation: false,
  }),

  emi_plan_unavailable: D({
    reason: 'emi_plan_unavailable',
    lists: ['general'],
    meaning: 'The selected EMI plan is not available.',
    baseCauseClass: 'funds_limits',
    requiresSourceDisambiguation: false,
  }),

  // ─── F · Risk ──────────────────────────────────────────────────────────────

  payment_risk_check_failed: D({
    reason: 'payment_risk_check_failed',
    lists: ['card', 'gateway'],
    meaning: 'A bank or risk system declined the transaction as potentially fraudulent.',
    baseCauseClass: 'risk',
    requiresSourceDisambiguation: false,
    note: 'Never surfaced to the customer as a fraud flag. One alternate-rail attempt, then stop.',
  }),

  card_declined: D({
    reason: 'card_declined',
    lists: ['card'],
    meaning: 'The issuing bank declined the card.',
    baseCauseClass: 'risk',
    requiresSourceDisambiguation: true,
    note: 'A catch-all the issuer often returns without a real reason. Treated conservatively as risk unless the tuple says otherwise.',
  }),

  mismatch_in_transaction_details: D({
    reason: 'mismatch_in_transaction_details',
    lists: ['general'],
    meaning: 'Transaction details do not match.',
    baseCauseClass: 'risk',
    requiresSourceDisambiguation: true,
  }),

  // ─── G · Merchant configuration ────────────────────────────────────────────

  bank_not_enabled: D({
    reason: 'bank_not_enabled',
    lists: ['general'],
    meaning: "The selected bank is not enabled for the merchant.",
    baseCauseClass: 'merchant_config',
    requiresSourceDisambiguation: true,
    note: 'From the merchant it is a config fault. From the gateway it can be a temporary delisting during an outage — which is transient_infra, not a config problem.',
  }),

  live_mode_not_enabled: D({
    reason: 'live_mode_not_enabled',
    lists: ['general'],
    meaning: 'A live payment was attempted while live mode is not enabled.',
    baseCauseClass: 'merchant_config',
    requiresSourceDisambiguation: false,
  }),

  merchant_not_activated: D({
    reason: 'merchant_not_activated',
    lists: ['general'],
    meaning: 'The merchant account is not activated.',
    baseCauseClass: 'merchant_config',
    requiresSourceDisambiguation: false,
  }),

  order_payment_method_mismatch: D({
    reason: 'order_payment_method_mismatch',
    lists: ['general'],
    meaning: 'The payment method does not match the order configuration.',
    baseCauseClass: 'merchant_config',
    requiresSourceDisambiguation: false,
  }),

  input_validation_failed: D({
    reason: 'input_validation_failed',
    lists: ['general'],
    meaning: 'Invalid or wrong input parameters.',
    baseCauseClass: 'merchant_config',
    requiresSourceDisambiguation: true,
  }),

  invalid_request: D({
    reason: 'invalid_request',
    lists: ['general'],
    meaning: 'Invalid request format.',
    baseCauseClass: 'merchant_config',
    requiresSourceDisambiguation: false,
  }),

  // ─── H · Terminal / no-op ──────────────────────────────────────────────────

  order_already_paid: D({
    reason: 'order_already_paid',
    lists: ['general'],
    meaning: 'The order already has a successful payment.',
    baseCauseClass: 'terminal_noop',
    requiresSourceDisambiguation: false,
    note: 'The most important row in this file. Closes the case and cancels every queued action. Messaging a customer who has already paid is the one mistake that ends the relationship.',
  }),

  duplicate_request: D({
    reason: 'duplicate_request',
    lists: ['general'],
    meaning: 'A duplicate request was submitted.',
    baseCauseClass: 'terminal_noop',
    requiresSourceDisambiguation: false,
  }),

  duplicate_refund_id: D({
    reason: 'duplicate_refund_id',
    lists: ['general'],
    meaning: 'The refund ID already exists.',
    baseCauseClass: 'terminal_noop',
    requiresSourceDisambiguation: false,
    note: 'Refund-side; carries no revenue at risk. Present for completeness so ingestion never meets an unknown code.',
  }),

  // ─── I · Deliberate exit ───────────────────────────────────────────────────

  payment_cancelled: D({
    reason: 'payment_cancelled',
    lists: ['card', 'gateway'],
    meaning: 'The customer cancelled or navigated back.',
    baseCauseClass: 'intent_exit',
    requiresSourceDisambiguation: false,
    note: 'A choice, not a malfunction. Routes to the intent_exit case type — never failure language, never failure-rate alerting.',
  }),

  // ─── Generic ───────────────────────────────────────────────────────────────

  payment_failed: D({
    reason: 'payment_failed',
    lists: ['general', 'card', 'gateway'],
    meaning: 'The bank or gateway failed the payment, with no further detail.',
    baseCauseClass: 'transient_infra',
    requiresSourceDisambiguation: true,
    note: 'The true long tail. Deliberately classified conservatively; learned per-bank priors will refine this once we have outcome data.',
  }),

  /** Not published by Razorpay — our own bucket for anything undocumented. */
  unknown_reason: D({
    reason: 'unknown_reason',
    lists: [],
    meaning: 'An undocumented or missing failure reason.',
    baseCauseClass: 'transient_infra',
    requiresSourceDisambiguation: true,
    note: 'Razorpay adds codes without notice. Ingestion maps anything unrecognised here, raises an internal alert, and applies the most cautious ladder rather than dropping the case.',
  }),
} as const satisfies Record<string, ErrorReasonDescriptor>;

export type ErrorReason = keyof typeof ERROR_REASONS;

export const ALL_ERROR_REASONS = Object.keys(ERROR_REASONS) as readonly ErrorReason[];

/** Reasons Razorpay actually publishes (excludes our `unknown_reason` bucket). */
export const DOCUMENTED_ERROR_REASONS = ALL_ERROR_REASONS.filter(
  (r) => ERROR_REASONS[r].lists.length > 0,
);

export function isKnownReason(reason: string): reason is ErrorReason {
  return Object.prototype.hasOwnProperty.call(ERROR_REASONS, reason);
}

export function descriptorFor(reason: string): ErrorReasonDescriptor {
  return isKnownReason(reason) ? ERROR_REASONS[reason] : ERROR_REASONS.unknown_reason;
}

/** Reasons appearing in more than one of Razorpay's published lists. */
export const OVERLAPPING_REASONS = DOCUMENTED_ERROR_REASONS.filter(
  (r) => ERROR_REASONS[r].lists.length > 1,
);
