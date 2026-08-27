/**
 * `deadline_at` — the moment the money is permanently gone.
 *
 * Every case needs one, because a recovery ladder without a hard stop becomes
 * harassment. The deadline is what turns "keep trying" into a bounded workflow
 * with a defined end state (`lost`), and it is what the attribution ledger
 * closes against.
 *
 * These are intent-decay horizons, not arbitrary timeouts. A customer who
 * abandoned a checkout two days ago is a different person from the one who
 * abandoned it twenty minutes ago; a B2B invoice, by contrast, is still
 * genuinely collectable a month later.
 */

import type { CaseType } from './types.js';
import { type Paise, amountBand } from '../money.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const BASE_WINDOW_MS: Readonly<Record<CaseType, number>> = {
  // Attended failure: intent is real but decays fast. Three days is generous.
  payment_failure: 72 * HOUR,
  // Deliberate exit: shorter. If they have not come back in two days, a fourth
  // message is not going to be the thing that changes their mind.
  intent_exit: 48 * HOUR,
  // Subscription: the longest attended runway, because the relationship — not
  // this single charge — is what is at stake.
  subscription_failure: 14 * DAY,
  // Receivables: commercial terms, not intent decay.
  receivable_overdue: 30 * DAY,
};

/**
 * Larger tickets justify a longer runway: the economics support more touches,
 * and big-ticket payers legitimately take longer (an approval chain, a salary
 * cycle, an AP run). Applied only where the delay is plausibly structural.
 */
function amountMultiplier(caseType: CaseType, amount: Paise): number {
  const band = amountBand(amount);
  if (caseType === 'intent_exit') return 1; // intent decay is not about ticket size
  if (band === 'enterprise') return 2;
  if (band === 'large') return 1.5;
  if (band === 'micro') return 0.5; // a Rs 200 order does not deserve three days
  return 1;
}

export interface DeadlineInput {
  readonly now: Date;
  readonly caseType: CaseType;
  readonly amount: Paise;
  /** Invoice due date, where one exists. Receivables count from due, not from now. */
  readonly dueAt?: Date | null;
}

export function computeDeadline(input: DeadlineInput): Date {
  const { now, caseType, amount, dueAt } = input;

  const window = BASE_WINDOW_MS[caseType] * amountMultiplier(caseType, amount);

  // A receivable's clock starts at its due date. Anchoring to "now" would give
  // an invoice that is already 60 days overdue a fresh 30-day runway, which is
  // how collections tools end up chasing debts nobody intends to pay.
  const anchor =
    caseType === 'receivable_overdue' && dueAt != null
      ? new Date(Math.max(dueAt.getTime(), now.getTime() - window))
      : now;

  const deadline = new Date(anchor.getTime() + window);

  // Never hand back a deadline in the past: a case must always get at least one
  // chance to act, or it would be born already `lost`.
  const floor = new Date(now.getTime() + 2 * HOUR);
  return deadline.getTime() < floor.getTime() ? floor : deadline;
}

export function isPastDeadline(deadlineAt: Date | null, now: Date): boolean {
  return deadlineAt != null && now.getTime() >= deadlineAt.getTime();
}

export function hoursUntilDeadline(deadlineAt: Date, now: Date): number {
  return (deadlineAt.getTime() - now.getTime()) / HOUR;
}
