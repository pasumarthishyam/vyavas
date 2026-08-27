/**
 * The RecoveryCase — the one object the whole product is built around.
 *
 * A failed payment, an abandoned checkout, a failed subscription renewal and an
 * overdue invoice are the same thing wearing different clothes:
 *
 *   a known customer, with known intent, owes a known amount, and something broke.
 *
 * Build the engine once; add sources.
 */

import type { Paise } from '../money.js';

// ─── Case type ───────────────────────────────────────────────────────────────

export const CASE_TYPES = [
  /** An attempted payment that failed. Customer tried; something went wrong. */
  'payment_failure',
  /**
   * The customer deliberately exited — `payment_cancelled`, or checkout
   * abandonment. NOT an error. This is a live intent signal and it is
   * architecturally separated so it can never be dressed in failure language,
   * never counts toward failure-rate alerting, and never triggers an apology.
   */
  'intent_exit',
  /** subscription.pending / subscription.halted — an unattended debit failed. */
  'subscription_failure',
  /** An invoice past its due date. */
  'receivable_overdue',
] as const;

export type CaseType = (typeof CASE_TYPES)[number];

// ─── Case state ──────────────────────────────────────────────────────────────

export const CASE_STATES = [
  'detected', // signal received, not yet classified
  'diagnosed', // cause class + policy resolved
  'executing', // ladder running
  'paused', // merchant kill-switch, budget exhausted, or manual hold
  'recovered', // terminal: the money arrived
  'lost', // terminal: deadline passed or ladder exhausted
  'aborted', // terminal: stopped deliberately (opt-out, already paid, duplicate)
] as const;

export type CaseState = (typeof CASE_STATES)[number];

export const TERMINAL_STATES = ['recovered', 'lost', 'aborted'] as const satisfies readonly CaseState[];
export type TerminalState = (typeof TERMINAL_STATES)[number];

export function isTerminal(state: CaseState): state is TerminalState {
  return (TERMINAL_STATES as readonly CaseState[]).includes(state);
}

// ─── Cohort ──────────────────────────────────────────────────────────────────

/**
 * Every case is assigned to treatment or holdout at diagnosis time.
 *
 * Holdout cases run the full workflow and log every action they *would* have
 * taken, but send nothing. Without this we cannot tell recovery from
 * coincidence — and we intend to invoice on incremental recovery, so this is
 * not an analytics nicety, it is the billing substrate.
 */
export const COHORTS = ['treatment', 'holdout'] as const;
export type Cohort = (typeof COHORTS)[number];

// ─── Payment method ──────────────────────────────────────────────────────────

export const PAYMENT_METHODS = [
  'card',
  'upi',
  'netbanking',
  'wallet',
  'emi',
  'cardless_emi',
  'paylater',
  'bank_transfer',
  'nach',
  'unknown',
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// ─── Alternate rails ─────────────────────────────────────────────────────────

/**
 * What we suggest the customer try instead.
 *
 * In India UPI is the universal escape hatch: it clears on rails independent of
 * card networks and most netbanking outages, it needs no card details, and it
 * is the default habit for the overwhelming majority of payers. For nearly
 * every card and netbanking failure class, "just use UPI" is the highest-yield
 * suggestion we have.
 *
 * `upi_intent` (deep-link into the customer's UPI app) is strongly preferred
 * over `upi_collect` (a request sent to a VPA they must type and then approve),
 * because intent removes both a typing step and an expiry window.
 */
export const ALTERNATE_RAILS = [
  'upi_intent',
  'upi_collect',
  'other_card',
  'netbanking',
  'wallet',
  'emi',
  'paylater',
  'bank_transfer',
  'retry_same', // same instrument, later — only where the class permits it
] as const;

export type AlternateRail = (typeof ALTERNATE_RAILS)[number];

// ─── The case ────────────────────────────────────────────────────────────────

/** The raw five-field tuple Razorpay gives us, plus routing context. */
export interface ErrorTuple {
  readonly errorCode: string | null;
  readonly errorSource: ErrorSource | null;
  readonly errorStep: ErrorStep | null;
  readonly errorReason: string | null;
  readonly method: PaymentMethod;
  readonly bank: string | null;
  readonly network: string | null;
}

/**
 * `error_source` is the field that disambiguates the overlaps the merchant
 * flagged: `authentication_failed` from `customer` is a recoverable typo;
 * from `gateway` or `bank` it is infrastructure. Never collapse the tuple.
 */
export const ERROR_SOURCES = [
  'customer',
  'business',
  'bank',
  'gateway',
  'issuer',
  'network',
  'internal',
  'nbfc',
  'unknown',
] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

export const ERROR_STEPS = [
  'payment_initiation',
  'payment_authentication',
  'payment_authorization',
  'payment_capture',
  'payment_response',
  'unknown',
] as const;
export type ErrorStep = (typeof ERROR_STEPS)[number];

export interface RecoveryCase {
  readonly id: string;
  readonly merchantId: string;
  readonly type: CaseType;
  readonly state: CaseState;

  readonly amountAtRisk: Paise;
  readonly currency: string;

  readonly rzpOrderId: string | null;
  readonly rzpPaymentId: string | null;
  readonly rzpInvoiceId: string | null;
  readonly rzpSubscriptionId: string | null;

  readonly tuple: ErrorTuple;
  readonly causeClass: string | null;

  /**
   * Attended = the customer is present or freshly reachable, and "retry" means
   * getting a human back to a payment surface.
   *
   * Unattended = a mandate exists (UPI Autopay / e-mandate / eNACH) and the
   * system may re-present the debit itself.
   *
   * Under RBI rules there is no third option: without a mandate we cannot
   * silently re-charge a card the way a US-market tool would. Getting this
   * flag wrong is not a bug, it is a compliance incident — so it is a required
   * field on every case, decided at diagnosis.
   */
  readonly attended: boolean;
  readonly mandateId: string | null;

  readonly customerId: string | null;
  readonly policyId: string | null;
  readonly policyVersion: number | null;

  readonly cohort: Cohort;
  readonly deadlineAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly recoveredAmount: Paise | null;
  readonly createdAt: Date;
}
