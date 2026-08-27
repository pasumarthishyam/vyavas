/**
 * Holdout assignment.
 *
 * A share of cases run the entire workflow and log every action they *would*
 * have taken, but send nothing. The gap between the two groups is the only
 * honest measure of what this product is worth — every dunning tool on the
 * market reports gross recovery, most of which would have arrived anyway.
 *
 * We intend to invoice on incremental recovery, so this function is not an
 * analytics convenience. It is the billing substrate, and it has three
 * requirements that follow from that:
 *
 *   1. DETERMINISTIC — the same case must land in the same bucket on every
 *      replay, forever. `Math.random()` would make attribution unauditable and
 *      is banned in core by lint.
 *   2. UNIFORM — no correlation with amount, merchant, bank or time of day, or
 *      the holdout stops being a fair control.
 *   3. STABLE UNDER RATE CHANGES — lowering the holdout from 10% to 5% must
 *      only ever *remove* cases from the holdout, never reshuffle them. A
 *      reshuffle would silently invalidate every historical comparison.
 *
 * (3) is why we hash to a fixed 0-9999 bucket and compare against a threshold,
 * rather than hashing with the rate mixed in.
 */

import { type Cohort } from './case/types.js';

/** FNV-1a, 32-bit. Chosen for being tiny, dependency-free and well distributed. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, kept inside 32 bits without overflowing to float
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const BUCKET_COUNT = 10_000;

/** Stable bucket in [0, 9999] for a case. */
export function cohortBucket(merchantId: string, caseId: string): number {
  return hash32(`${merchantId}:${caseId}`) % BUCKET_COUNT;
}

export interface CohortInput {
  readonly merchantId: string;
  readonly caseId: string;
  /** Holdout share in basis points. 500 = 5%. */
  readonly holdoutBasisPoints: number;
  /**
   * Merchant-level opt-out. Some merchants will refuse a holdout, and that is
   * their right — but their cases are then excluded from incrementality
   * reporting rather than silently counted as if they had a control.
   */
  readonly holdoutEnabled: boolean;
  /**
   * Policy-level opt-out. Never hold out a case whose class does not contact
   * the customer anyway (terminal_noop), and never hold out merchant-fault
   * alerting — withholding "your checkout is broken" would be indefensible.
   */
  readonly eligible: boolean;
}

export function assignCohort(input: CohortInput): Cohort {
  const { merchantId, caseId, holdoutBasisPoints, holdoutEnabled, eligible } = input;

  if (!holdoutEnabled || !eligible) return 'treatment';
  if (holdoutBasisPoints <= 0) return 'treatment';
  if (holdoutBasisPoints >= BUCKET_COUNT) return 'holdout';

  return cohortBucket(merchantId, caseId) < holdoutBasisPoints ? 'holdout' : 'treatment';
}

/** True when the case may not be held out regardless of merchant settings. */
export function isHoldoutEligible(opts: {
  contactsCustomer: boolean;
  alertsMerchant: boolean;
}): boolean {
  if (!opts.contactsCustomer) return false;
  if (opts.alertsMerchant) return false;
  return true;
}
