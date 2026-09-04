/**
 * The case state machine.
 *
 * Declared as a table rather than scattered `if` statements so that "can this
 * case legally move from X to Y" has exactly one answer, in one place, testable
 * without a database.
 *
 * The invariant that matters most: **terminal states are terminal.** Once a case
 * is `recovered`, nothing may reopen it. That is the guard standing between us
 * and messaging a customer who has already paid — the single failure mode that
 * would get this product ripped out of a merchant's stack permanently.
 */

import { type Result, ok, err } from '../../lib/result.js';
import { type CaseState, isTerminal } from './types.js';

export type TransitionReason =
  | 'diagnosed'
  | 'ladder_started'
  | 'paused_by_merchant'
  | 'paused_budget_exhausted'
  | 'resumed'
  | 'payment_received'
  | 'deadline_passed'
  | 'ladder_exhausted'
  | 'already_paid'
  | 'customer_opted_out'
  | 'duplicate_case'
  | 'merchant_disconnected'
  | 'manual_abort'
  /**
   * Parked by a pause for longer than a first message can honestly reach back.
   *
   * `aborted`, not `lost`, and the distinction is the one this file already
   * draws everywhere else: `lost` means we tried and ran out of runway, and we
   * did not try. Counting these as treatment failures would understate what
   * recovery is worth by exactly the number of cases nobody was allowed to
   * treat.
   */
  | 'stale_after_pause';

const TRANSITIONS: Readonly<Record<CaseState, readonly CaseState[]>> = {
  detected: ['diagnosed', 'aborted'],
  diagnosed: ['executing', 'paused', 'recovered', 'aborted', 'lost'],
  executing: ['paused', 'recovered', 'lost', 'aborted'],
  paused: ['executing', 'recovered', 'lost', 'aborted'],
  recovered: [],
  lost: [],
  aborted: [],
};

/**
 * Which reasons justify which destination. Keeps the ledger honest: a case that
 * ended in `recovered` must have got there via `payment_received`, not via a
 * workflow bug that guessed.
 */
const REASONS_FOR: Readonly<Record<CaseState, readonly TransitionReason[]>> = {
  detected: [],
  diagnosed: ['diagnosed'],
  executing: ['ladder_started', 'resumed'],
  paused: ['paused_by_merchant', 'paused_budget_exhausted'],
  recovered: ['payment_received'],
  lost: ['deadline_passed', 'ladder_exhausted'],
  aborted: [
    'already_paid',
    'customer_opted_out',
    'duplicate_case',
    'merchant_disconnected',
    'manual_abort',
    'stale_after_pause',
  ],
};

export interface TransitionError {
  readonly kind: 'illegal_transition' | 'terminal_state' | 'reason_mismatch';
  readonly from: CaseState;
  readonly to: CaseState;
  readonly reason: TransitionReason;
  readonly message: string;
}

export function canTransition(from: CaseState, to: CaseState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: CaseState): readonly CaseState[] {
  return TRANSITIONS[from];
}

/**
 * Validate a transition. Returns a Result rather than throwing, because an
 * illegal transition is usually a genuine race (two workflow steps observing a
 * payment at once) that the caller should absorb, not a crash.
 */
export function transition(
  from: CaseState,
  to: CaseState,
  reason: TransitionReason,
): Result<CaseState, TransitionError> {
  if (isTerminal(from)) {
    return err({
      kind: 'terminal_state',
      from,
      to,
      reason,
      message:
        `Case is already terminal (${from}); it cannot move to ${to}. ` +
        `A terminal case never reopens — this is the guard against acting on a case that is done.`,
    });
  }

  if (!canTransition(from, to)) {
    return err({
      kind: 'illegal_transition',
      from,
      to,
      reason,
      message: `Illegal transition ${from} -> ${to}. Allowed: ${TRANSITIONS[from].join(', ') || '(none)'}`,
    });
  }

  if (!REASONS_FOR[to].includes(reason)) {
    return err({
      kind: 'reason_mismatch',
      from,
      to,
      reason,
      message:
        `Reason '${reason}' does not justify moving to '${to}'. ` +
        `Valid reasons: ${REASONS_FOR[to].join(', ')}`,
    });
  }

  return ok(to);
}

/**
 * Does this transition stop all in-flight work?
 *
 * The workflow calls this after every state change; `true` means cancel every
 * pending ladder rung immediately.
 */
export function haltsExecution(to: CaseState): boolean {
  return isTerminal(to) || to === 'paused';
}
