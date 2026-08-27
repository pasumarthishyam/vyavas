/**
 * Diagnosis: `ErrorTuple` + context -> what is actually wrong, and what that
 * implies about how we may behave.
 *
 * Pure. No I/O, no wall clock, no randomness. Everything it needs — the time,
 * the live downtime feed, the attempt history, whether a mandate exists — is
 * passed in. That is what lets us unit-test "9:04pm on a Sunday during an ICICI
 * netbanking outage, third attempt, mandate present" as a table row.
 *
 * Order of operations, and it matters:
 *
 *   1. Resolve a cause class from the tuple (most-specific rule wins).
 *   2. Apply the live downtime override — a decline during a confirmed bank
 *      outage is an outage, not a customer problem.
 *   3. Apply attempt-history tightening — never walk someone into a card lock.
 *   4. Decide attended vs unattended. Under RBI rules this is a compliance
 *      boundary, not a preference.
 *   5. Derive suggested rails, and enforce internal consistency.
 *   6. Reassign case type where the class demands it (intent_exit).
 */

import {
  type AlternateRail,
  type CaseType,
  type ErrorSource,
  type ErrorStep,
  type ErrorTuple,
  type PaymentMethod,
} from '../case/types.js';
import { computeDeadline } from '../case/deadline.js';
import { type Paise, amountBand } from '../money.js';
import {
  type CauseClass,
  type CauseClassTraits,
  CAUSE_CLASS_TRAITS,
} from './cause-class.js';
import { descriptorFor } from './codes.js';

// ─── context ─────────────────────────────────────────────────────────────────

export interface AttemptRecord {
  readonly at: Date;
  readonly method: PaymentMethod;
  readonly errorReason: string | null;
}

/** A live outage as reported by Razorpay's downtime feed. */
export interface DowntimeWindow {
  /** `'all'` when the outage is not method-specific. */
  readonly method: PaymentMethod | 'all';
  /** `null` when the outage spans all banks for that method. */
  readonly bank: string | null;
  readonly network: string | null;
  readonly severity: 'low' | 'medium' | 'high';
  readonly startedAt: Date;
}

export interface DiagnoseContext {
  readonly now: Date;
  readonly caseType: CaseType;
  readonly amount: Paise;
  /** True when a UPI Autopay / e-mandate / eNACH mandate exists for this payer. */
  readonly hasMandate: boolean;
  /** Outages currently open, from the downtime table. */
  readonly activeDowntime: readonly DowntimeWindow[];
  /** Prior payment attempts on this order, oldest first. */
  readonly priorAttempts: readonly AttemptRecord[];
  /** Invoice due date, for receivables. */
  readonly dueAt?: Date | null;
}

// ─── output ──────────────────────────────────────────────────────────────────

export type Confidence = 'high' | 'medium' | 'low';

export interface Diagnosis {
  readonly causeClass: CauseClass;
  /** Case type after any reassignment — e.g. a cancelled payment becomes intent_exit. */
  readonly caseType: CaseType;

  readonly sameInstrumentRetry: boolean;
  readonly contactCustomer: boolean;
  readonly alertMerchant: boolean;
  readonly maxCustomerTouches: number;
  readonly minFirstTouchMinutes: number;
  readonly suggestedRails: readonly AlternateRail[];
  readonly framing: CauseClassTraits['framing'];

  /** Wait on the downtime feed rather than a fixed timer. */
  readonly downtimeGated: boolean;
  readonly matchedDowntime: DowntimeWindow | null;

  /**
   * Attended = a human must come back to a payment surface.
   * Unattended = a mandate exists and the debit may be re-presented.
   *
   * There is no third option in India. Getting this wrong is a compliance
   * incident, not a bug, so it is always explicit and always justified in
   * `rationale`.
   */
  readonly attended: boolean;

  /** Terminal no-op — close the case and cancel everything queued. */
  readonly shouldAbort: boolean;
  readonly abortReason: string | null;

  readonly deadlineAt: Date;
  readonly confidence: Confidence;
  readonly matchedRuleId: string;
  /** Human-readable trace of every decision, for the audit log and the UI. */
  readonly rationale: readonly string[];
}

// ─── disambiguation rules ────────────────────────────────────────────────────

interface Rule {
  readonly id: string;
  readonly reason: string;
  readonly source?: readonly ErrorSource[];
  readonly step?: readonly ErrorStep[];
  readonly method?: readonly PaymentMethod[];
  readonly causeClass: CauseClass;
  readonly why: string;
}

/**
 * Only reasons whose meaning genuinely changes with source/step/method appear
 * here. Everything else is classified by `baseCauseClass` in codes.ts.
 *
 * Specificity = number of constrained dimensions. Highest wins; ties break on
 * declaration order, and a test asserts no two rules can tie for one tuple.
 */
const RULES: readonly Rule[] = [
  // authentication_failed — the canonical overlap.
  {
    id: 'auth_failed.customer',
    reason: 'authentication_failed',
    source: ['customer'],
    causeClass: 'customer_input',
    why: 'Authentication failed at the customer: a wrong or mistyped OTP, which is a recoverable typo rather than an infrastructure problem.',
  },
  {
    id: 'auth_failed.infra',
    reason: 'authentication_failed',
    source: ['gateway', 'bank', 'issuer', 'network'],
    causeClass: 'auth_friction',
    why: 'Authentication failed upstream of the customer — the 3DS or OTP path itself did not complete.',
  },

  // bank_not_enabled — merchant config vs a temporary delisting.
  {
    id: 'bank_not_enabled.merchant',
    reason: 'bank_not_enabled',
    source: ['business', 'internal'],
    causeClass: 'merchant_config',
    why: 'The bank is not enabled on the merchant account. Every customer choosing it is a total loss until the merchant acts.',
  },
  {
    id: 'bank_not_enabled.gateway',
    reason: 'bank_not_enabled',
    source: ['gateway', 'bank'],
    causeClass: 'transient_infra',
    why: 'The gateway reported the bank unavailable rather than unconfigured — a temporary delisting during an outage, not a merchant fault.',
  },

  // invalid_vpa — typo vs a handle that no longer exists.
  {
    id: 'invalid_vpa.customer',
    reason: 'invalid_vpa',
    source: ['customer'],
    causeClass: 'customer_input',
    why: 'The VPA was mistyped. Correctable in seconds, and UPI intent avoids the typing entirely.',
  },
  {
    id: 'invalid_vpa.dead',
    reason: 'invalid_vpa',
    source: ['bank', 'gateway', 'network'],
    causeClass: 'instrument_dead',
    why: 'The VPA was rejected upstream — the handle is deregistered or invalid, so it will never work.',
  },

  // mobile_number_invalid — also determines whether SMS is deliverable at all.
  {
    id: 'mobile_invalid.merchant',
    reason: 'mobile_number_invalid',
    source: ['business', 'internal'],
    causeClass: 'merchant_config',
    why: 'The merchant sent an invalid contact number. SMS is undeliverable for this customer until it is corrected.',
  },
  {
    id: 'mobile_invalid.customer',
    reason: 'mobile_number_invalid',
    source: ['customer'],
    causeClass: 'customer_input',
    why: 'The customer entered an invalid mobile number.',
  },

  // invalid_user_details
  {
    id: 'invalid_user.merchant',
    reason: 'invalid_user_details',
    source: ['business', 'internal'],
    causeClass: 'merchant_config',
    why: 'Customer details supplied by the merchant were rejected.',
  },
  {
    id: 'invalid_user.customer',
    reason: 'invalid_user_details',
    source: ['customer'],
    causeClass: 'customer_input',
    why: 'The customer entered details the bank rejected.',
  },

  // input_validation_failed
  {
    id: 'input_validation.customer',
    reason: 'input_validation_failed',
    source: ['customer'],
    causeClass: 'customer_input',
    why: 'A field the customer filled in was rejected.',
  },
  {
    id: 'input_validation.merchant',
    reason: 'input_validation_failed',
    source: ['business', 'internal', 'gateway'],
    causeClass: 'merchant_config',
    why: 'The integration sent parameters the API rejected — a merchant-side defect affecting every customer on that path.',
  },

  // card_declined — issuers return this with no real detail.
  {
    id: 'card_declined.issuer_auth',
    reason: 'card_declined',
    source: ['issuer', 'bank'],
    step: ['payment_authorization'],
    causeClass: 'risk',
    why: 'The issuer declined at authorisation without detail. Treated as a risk decline, which is the conservative reading: re-presenting would raise the risk score.',
  },
  {
    id: 'card_declined.gateway',
    reason: 'card_declined',
    source: ['gateway'],
    causeClass: 'transient_infra',
    why: 'The gateway, not the issuer, reported the decline — more consistent with a routing or availability problem.',
  },

  // mismatch_in_transaction_details
  {
    id: 'mismatch.merchant',
    reason: 'mismatch_in_transaction_details',
    source: ['business', 'internal'],
    causeClass: 'merchant_config',
    why: 'The transaction details the merchant sent are internally inconsistent.',
  },

  // authorisation_declined_by_psp — the two readings must not overlap, so the
  // risk reading is scoped to card-family rails. On UPI an issuer decline is
  // routine PSP behaviour, not a judgement about the payer, and treating it as
  // risk would cap a recoverable case at a single touch.
  {
    id: 'psp_declined.risk',
    reason: 'authorisation_declined_by_psp',
    source: ['issuer', 'network'],
    method: ['card', 'emi', 'cardless_emi'],
    causeClass: 'risk',
    why: 'The issuer or network declined a card authorisation, which reads as a risk decision rather than availability.',
  },
  {
    id: 'psp_declined.upi',
    reason: 'authorisation_declined_by_psp',
    method: ['upi'],
    causeClass: 'transient_infra',
    why: 'UPI PSP declines are overwhelmingly transient — PSP-side capacity or routing rather than a decision about this payer.',
  },

  // payment_failed — the long tail.
  {
    id: 'payment_failed.merchant',
    reason: 'payment_failed',
    source: ['business', 'internal'],
    causeClass: 'merchant_config',
    why: 'A generic failure attributed to the merchant integration.',
  },
  {
    id: 'payment_failed.customer',
    reason: 'payment_failed',
    source: ['customer'],
    causeClass: 'auth_friction',
    why: 'A generic failure attributed to the customer, most often an abandoned or timed-out authentication step.',
  },

  // unknown_reason — undocumented codes.
  {
    id: 'unknown.merchant',
    reason: 'unknown_reason',
    source: ['business', 'internal'],
    causeClass: 'merchant_config',
    why: 'An undocumented failure attributed to the merchant integration.',
  },
];

function ruleSpecificity(r: Rule): number {
  return (r.source ? 1 : 0) + (r.step ? 1 : 0) + (r.method ? 1 : 0);
}

function ruleMatches(r: Rule, tuple: ErrorTuple): boolean {
  if (r.reason !== tuple.errorReason) return false;
  if (r.source && !(tuple.errorSource && r.source.includes(tuple.errorSource))) return false;
  if (r.step && !(tuple.errorStep && r.step.includes(tuple.errorStep))) return false;
  if (r.method && !r.method.includes(tuple.method)) return false;
  return true;
}

/** Exported for the ambiguity test in the golden suite. */
export function matchingRules(tuple: ErrorTuple): readonly Rule[] {
  return RULES.filter((r) => ruleMatches(r, tuple));
}

function resolveClass(tuple: ErrorTuple): {
  causeClass: CauseClass;
  ruleId: string;
  why: string;
} {
  const matches = [...matchingRules(tuple)].sort(
    (a, b) => ruleSpecificity(b) - ruleSpecificity(a),
  );
  const best = matches[0];
  if (best) return { causeClass: best.causeClass, ruleId: best.id, why: best.why };

  const descriptor = descriptorFor(tuple.errorReason ?? 'unknown_reason');
  return {
    causeClass: descriptor.baseCauseClass,
    ruleId: `base.${descriptor.reason}`,
    why: descriptor.meaning,
  };
}

// ─── downtime ────────────────────────────────────────────────────────────────

/**
 * Reasons that a confirmed outage can plausibly explain.
 *
 * Deliberately narrow. An expired card is expired whether or not HDFC is down,
 * and a typo is a typo — reclassifying those would produce a message telling
 * the customer to wait for a bank that was never their problem.
 */
const DOWNTIME_ELIGIBLE_REASONS: ReadonlySet<string> = new Set([
  'bank_technical_error',
  'gateway_technical_error',
  'bank_not_available',
  'bank_cutoff_in_progress',
  'authorisation_declined_by_psp',
  'authentication_failed',
  'payment_failed',
  'payment_timed_out',
  'card_declined',
  'bank_not_enabled',
  'unknown_reason',
]);

export function findMatchingDowntime(
  tuple: ErrorTuple,
  windows: readonly DowntimeWindow[],
): DowntimeWindow | null {
  for (const w of windows) {
    const methodOk = w.method === 'all' || w.method === tuple.method;
    const bankOk = w.bank === null || (tuple.bank !== null && w.bank === tuple.bank);
    const networkOk = w.network === null || (tuple.network !== null && w.network === tuple.network);
    if (methodOk && bankOk && networkOk) return w;
  }
  return null;
}

// ─── attempt history ─────────────────────────────────────────────────────────

/**
 * How many same-instrument attempts we tolerate before forcing a rail switch.
 *
 * These are not tuning knobs. Three wrong OTPs commonly locks a card at the
 * issuer, and repeated wrong UPI PINs lock the handle at NPCI. Exceeding them
 * does not just fail — it takes the customer's payment instrument away.
 */
const SAME_INSTRUMENT_ATTEMPT_CAP: Readonly<Record<string, number>> = {
  incorrect_otp: 2,
  incorrect_pin: 2,
  incorrect_atm_pin: 2,
  authentication_failed: 2,
  incorrect_cvv: 3,
};
const DEFAULT_ATTEMPT_CAP = 3;

function sameReasonAttempts(tuple: ErrorTuple, attempts: readonly AttemptRecord[]): number {
  return attempts.filter(
    (a) => a.errorReason === tuple.errorReason && a.method === tuple.method,
  ).length;
}

// ─── rails ───────────────────────────────────────────────────────────────────

function railsFor(
  causeClass: CauseClass,
  tuple: ErrorTuple,
  amount: Paise,
  sameInstrumentRetry: boolean,
): readonly AlternateRail[] {
  const traits = CAUSE_CLASS_TRAITS[causeClass];

  // A class we do not speak to the customer about gets no rails at all. This
  // guard has to come FIRST: the UPI boost below is unconditional on method,
  // and without this an `order_already_paid` case would arrive carrying a
  // suggestion to go and pay again by UPI.
  if (!traits.contactCustomer) return [];

  let rails: AlternateRail[] = [...traits.defaultRails];

  // In India UPI is the escape hatch for almost every card and netbanking
  // failure: independent rails, no card details, and it is the default habit.
  if (tuple.method === 'card' || tuple.method === 'netbanking' || tuple.method === 'emi') {
    rails = ['upi_intent', ...rails.filter((r) => r !== 'upi_intent')];
  }

  // A dead UPI handle must not be answered with "try UPI collect" — collect
  // sends a request to the very VPA that just failed.
  if (tuple.method === 'upi') {
    rails = rails.filter((r) => r !== 'upi_collect');
    if (causeClass === 'instrument_dead') {
      rails = rails.filter((r) => r !== 'upi_intent');
      rails = [...rails, 'other_card', 'netbanking'];
    }
  }

  // Funds shortfalls: spreading the cost is a genuine answer, but only where
  // the ticket is large enough for EMI or pay-later to exist.
  if (causeClass === 'funds_limits') {
    const band = amountBand(amount);
    if (band === 'micro' || band === 'small') {
      rails = rails.filter((r) => r !== 'emi');
    }
  }

  // Consistency guard: a class that forbids re-presenting the instrument must
  // never suggest doing so. Without this, a policy row and a class trait could
  // disagree and the disagreement would reach a customer.
  if (!sameInstrumentRetry) {
    rails = rails.filter((r) => r !== 'retry_same');
  }

  return [...new Set(rails)];
}

// ─── attended / unattended ───────────────────────────────────────────────────

function decideAttended(
  causeClass: CauseClass,
  ctx: DiagnoseContext,
  rationale: string[],
): boolean {
  if (!ctx.hasMandate) {
    rationale.push(
      'Attended: no mandate exists, so there is no lawful way to re-present this debit. ' +
        'Recovery means bringing the customer back to a payment surface.',
    );
    return true;
  }

  // A mandate riding a dead instrument is itself dead. This needs re-registration
  // with AFA, not a retry — treating it as unattended would burn attempts against
  // a mandate that can never succeed.
  if (causeClass === 'instrument_dead') {
    rationale.push(
      'Attended despite an active mandate: the underlying instrument is unusable, so the ' +
        'mandate cannot succeed either. This requires re-registration with AFA, not a re-presentment.',
    );
    return true;
  }

  const unattendedTypes: readonly CaseType[] = ['subscription_failure', 'receivable_overdue'];
  if (unattendedTypes.includes(ctx.caseType)) {
    rationale.push(
      'Unattended: an active mandate covers this debit, so it may be re-presented — subject to ' +
        'the pre-debit notification requirement and the mandate ceiling.',
    );
    return false;
  }

  rationale.push(
    'Attended: a mandate exists but this is a one-off order rather than a mandated debit.',
  );
  return true;
}

// ─── confidence ──────────────────────────────────────────────────────────────

function confidenceFor(tuple: ErrorTuple, ruleId: string): Confidence {
  if (tuple.errorReason === 'unknown_reason') return 'low';
  const descriptor = descriptorFor(tuple.errorReason ?? 'unknown_reason');
  if (!descriptor.requiresSourceDisambiguation) return 'high';
  // The reason is ambiguous and no refining rule fired — we are on the base class.
  return ruleId.startsWith('base.') ? 'medium' : 'high';
}

// ─── the entry point ─────────────────────────────────────────────────────────

export function diagnose(tuple: ErrorTuple, ctx: DiagnoseContext): Diagnosis {
  const rationale: string[] = [];

  // 1 — classify
  const resolved = resolveClass(tuple);
  let causeClass = resolved.causeClass;
  let matchedRuleId = resolved.ruleId;
  rationale.push(resolved.why);

  // 2 — downtime override
  let matchedDowntime: DowntimeWindow | null = null;
  if (DOWNTIME_ELIGIBLE_REASONS.has(tuple.errorReason ?? '')) {
    matchedDowntime = findMatchingDowntime(tuple, ctx.activeDowntime);
    if (matchedDowntime && causeClass !== 'transient_infra') {
      rationale.push(
        `Reclassified to transient infrastructure: a confirmed ${matchedDowntime.severity}-severity ` +
          `outage is open for ${matchedDowntime.bank ?? 'all banks'} on ` +
          `${matchedDowntime.method}. The instrument is fine; only the timing was bad.`,
      );
      causeClass = 'transient_infra';
      matchedRuleId = `${matchedRuleId}+downtime`;
    } else if (matchedDowntime) {
      rationale.push(
        `A confirmed outage is open for ${matchedDowntime.bank ?? 'all banks'} on ` +
          `${matchedDowntime.method}. Wait for resolution rather than a fixed timer.`,
      );
    }
  }

  const traits = CAUSE_CLASS_TRAITS[causeClass];

  // 3 — attempt-history tightening
  let sameInstrumentRetry = traits.sameInstrumentRetry;
  const attemptsSoFar = sameReasonAttempts(tuple, ctx.priorAttempts);
  const cap = SAME_INSTRUMENT_ATTEMPT_CAP[tuple.errorReason ?? ''] ?? DEFAULT_ATTEMPT_CAP;

  if (sameInstrumentRetry && attemptsSoFar >= cap) {
    sameInstrumentRetry = false;
    rationale.push(
      `Same-instrument retry withdrawn after ${attemptsSoFar} attempt(s) on this reason ` +
        `(cap ${cap}). Further attempts risk locking the instrument at the issuer or NPCI, ` +
        `which would cost the customer more than this order is worth.`,
    );
  }

  // 4 — attended vs unattended
  const attended = decideAttended(causeClass, ctx, rationale);

  // 5 — rails
  const suggestedRails = railsFor(causeClass, tuple, ctx.amount, sameInstrumentRetry);

  // 6 — case type reassignment
  let caseType = ctx.caseType;
  if (causeClass === 'intent_exit' && caseType === 'payment_failure') {
    caseType = 'intent_exit';
    rationale.push(
      'Re-typed as a deliberate exit rather than a failure. The customer chose to leave, so this ' +
        'is a live intent signal: it never receives failure language and never counts toward ' +
        'failure-rate alerting.',
    );
  }

  const shouldAbort = causeClass === 'terminal_noop';
  if (shouldAbort) {
    rationale.push(
      'Terminal: there is no revenue at risk. Close the case and cancel every queued action ' +
        'immediately — contacting this customer would be worse than doing nothing.',
    );
  }

  const deadlineAt = computeDeadline({
    now: ctx.now,
    caseType,
    amount: ctx.amount,
    dueAt: ctx.dueAt ?? null,
  });

  return {
    causeClass,
    caseType,
    sameInstrumentRetry,
    contactCustomer: traits.contactCustomer && !shouldAbort,
    alertMerchant: traits.alertMerchant,
    maxCustomerTouches: shouldAbort ? 0 : traits.maxCustomerTouches,
    minFirstTouchMinutes: traits.minFirstTouchMinutes,
    suggestedRails,
    framing: traits.framing,
    downtimeGated: traits.downtimeGated || matchedDowntime !== null,
    matchedDowntime,
    attended,
    shouldAbort,
    abortReason: shouldAbort
      ? (descriptorFor(tuple.errorReason ?? 'unknown_reason').meaning ?? 'terminal')
      : null,
    deadlineAt,
    confidence: confidenceFor(tuple, matchedRuleId),
    matchedRuleId,
    rationale,
  };
}
