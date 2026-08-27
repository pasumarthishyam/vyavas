/**
 * The resolver: a case's facts -> the one ladder that applies.
 *
 * Pure and total. Every input resolves to exactly one row, because compile.ts
 * refuses to build a table without a catch-all. A case that cannot be matched
 * would be a case we silently drop, and a dropped case is money we lost without
 * noticing — so "no policy found" is a build-time failure, never a runtime one.
 */

import type { AmountBand } from '../money.js';
import { amountBand } from '../money.js';
import type {
  AlternateRail,
  CaseType,
  ErrorSource,
  ErrorStep,
  ErrorTuple,
  PaymentMethod,
} from '../case/types.js';
import type { Paise } from '../money.js';
import type { CauseClass } from '../taxonomy/cause-class.js';
import type { Diagnosis } from '../taxonomy/diagnose.js';
import type { PolicyMatch, PolicyRow } from './schema.js';
import { rowSpecificity } from './specificity.js';

/** Everything a row is allowed to match on. */
export interface PolicyMatchInput {
  readonly errorReason: string;
  readonly errorSource: ErrorSource | null;
  readonly errorStep: ErrorStep | null;
  readonly method: PaymentMethod;
  readonly bank: string | null;
  readonly causeClass: CauseClass;
  readonly caseType: CaseType;
  readonly amountBand: AmountBand;
  readonly attended: boolean;
}

/** Build the resolver input from a diagnosis. The single supported path. */
export function matchInputFrom(
  tuple: ErrorTuple,
  diagnosis: Diagnosis,
  amount: Paise,
): PolicyMatchInput {
  return {
    errorReason: tuple.errorReason ?? 'unknown_reason',
    errorSource: tuple.errorSource,
    errorStep: tuple.errorStep,
    method: tuple.method,
    bank: tuple.bank,
    // From the DIAGNOSIS, not the raw tuple: a decline during a confirmed
    // outage has already been reclassified, and the ladder must follow the
    // reclassification rather than the original appearance.
    causeClass: diagnosis.causeClass,
    caseType: diagnosis.caseType,
    amountBand: amountBand(amount),
    attended: diagnosis.attended,
  };
}

function listMatches<T extends string>(
  constraint: readonly T[] | undefined,
  value: T | null,
): boolean {
  if (constraint === undefined) return true;
  if (value === null) return false;
  return constraint.includes(value);
}

export function matchesPolicy(match: PolicyMatch, input: PolicyMatchInput): boolean {
  if (match.errorReason !== undefined && match.errorReason !== input.errorReason) return false;
  if (!listMatches(match.errorSource, input.errorSource)) return false;
  if (!listMatches(match.errorStep, input.errorStep)) return false;
  if (!listMatches(match.method, input.method)) return false;
  if (!listMatches(match.bank, input.bank)) return false;
  if (!listMatches(match.causeClass, input.causeClass)) return false;
  if (!listMatches(match.caseType, input.caseType)) return false;
  if (!listMatches(match.amountBand, input.amountBand)) return false;
  if (match.attended !== undefined && match.attended !== input.attended) return false;
  return true;
}

export interface ResolvedPolicy {
  readonly row: PolicyRow;
  readonly specificity: number;
  /** Every row that matched, most specific first. For the audit trail and UI. */
  readonly candidates: readonly PolicyRow[];
}

export class PolicyResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyResolutionError';
  }
}

/**
 * Resolve most-specific-first.
 *
 * The catch-all scores -1 so it can only ever win when nothing else matched,
 * regardless of how sparsely the rest of the table is written.
 *
 * Ties break on `id` for determinism, but a tie between rows with different
 * ladders is a table defect — `assertNoAmbiguity` in compile.ts fails the build
 * on it, so the tiebreak here is a belt-and-braces measure rather than a policy.
 */
export function resolvePolicy(
  table: readonly PolicyRow[],
  input: PolicyMatchInput,
): ResolvedPolicy {
  const candidates = table
    .filter((row) => row.catchAll || matchesPolicy(row.match, input))
    .sort((a, b) => {
      const d = rowSpecificity(b) - rowSpecificity(a);
      return d !== 0 ? d : a.id.localeCompare(b.id);
    });

  const row = candidates[0];
  if (!row) {
    throw new PolicyResolutionError(
      `No policy matched ${JSON.stringify(input)}. A compiled table always contains a ` +
        `catch-all, so this means the table was constructed without compilePolicyTable().`,
    );
  }

  return { row, specificity: rowSpecificity(row), candidates };
}

/** The rungs that reach a customer — what `maxMessages` actually caps. */
export function customerTouchRungs(row: PolicyRow) {
  return row.ladder.filter(
    (r) => r.action === 'nudge' || r.action === 'send_pre_debit_notice',
  );
}

/**
 * The rails a nudge may actually suggest.
 *
 * The runtime counterpart to compile.ts's static check, and it is needed
 * because the two sources of truth know different things:
 *
 *   - The POLICY TABLE is static. `customer_input.incorrect_otp` legitimately
 *     offers `retry_same` on its first rung, because for most payers a wrong
 *     OTP is a late SMS and one more attempt works.
 *   - The DIAGNOSIS has live context the table cannot have. If this payer has
 *     already failed OTP twice, `diagnose()` has withdrawn same-instrument
 *     retry — because a third attempt commonly locks the card at the issuer.
 *
 * When they disagree, the live context wins, and it may only ever REMOVE rails.
 * A policy row can never re-authorise something the diagnosis has ruled out.
 */
export function effectiveRails(
  rungSuggest: readonly AlternateRail[] | undefined,
  diagnosis: Diagnosis,
): readonly AlternateRail[] {
  // No `suggest` on the rung means "use what the diagnosis worked out", which
  // already accounts for the failing method (a dead VPA is never offered UPI).
  const base = rungSuggest ?? diagnosis.suggestedRails;
  return diagnosis.sameInstrumentRetry ? base : base.filter((r) => r !== 'retry_same');
}
