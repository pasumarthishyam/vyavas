/**
 * How many times this agent may phone one person about one case.
 *
 * Until now: no limit at all. The console showed a call count and enforced
 * nothing, so the same case could be called five times in an afternoon by
 * clicking the same button five times. A phone call is the most intrusive thing
 * this product does, and it was the only action with no ceiling on it.
 *
 * Two, and then a person has to decide.
 *
 * ── why a flat two, and not "two unless they asked us to call back" ──
 *
 * The conditional version was considered and rejected: it needs the agent to
 * report an outcome ("they asked me to call later"), and every version of that
 * ends with a model's summary of a conversation deciding whether a real person
 * gets phoned again. A count is a fact. If the second call genuinely warrants a
 * third, a human is one click away — and that click is recorded.
 *
 * ── the override is deliberate, not a loophole ──
 *
 * A ceiling nobody can pass is a ceiling people route around: they will call
 * from their own phone, and the record of it will not exist. So the third call
 * is available, behind a warning that states plainly what it is, and it is
 * written to the case timeline as a human decision with a name on it. Bounded
 * autonomy is about where the boundary sits, not about pretending people never
 * cross one.
 *
 * Pure. `callsPlaced` is passed in, so every branch is a table row.
 */

/** Calls this agent may place on one case before a person has to authorise it. */
export const MAX_CALLS_PER_CASE = 2;

export interface CallLimitFacts {
  /** Calls already placed on this case, in any state — queued, failed, ended. */
  readonly callsPlaced: number;
  /**
   * A person has seen the warning and chosen to continue.
   *
   * Only ever set by an explicit confirmation in the console. It is not a
   * parameter any automated path passes.
   */
  readonly override: boolean;
}

export type CallLimitDecision =
  /** Inside the limit. Place the call. */
  | { readonly allowed: true; readonly override: false; readonly remaining: number }
  /** Past the limit, and a person said to go ahead anyway. */
  | { readonly allowed: true; readonly override: true; readonly reason: string }
  /** Past the limit. The console offers the override; nothing else may. */
  | { readonly allowed: false; readonly reason: string; readonly overridable: true };

export function authorizeCall(facts: CallLimitFacts): CallLimitDecision {
  const placed = Math.max(0, Math.trunc(facts.callsPlaced));

  if (placed < MAX_CALLS_PER_CASE) {
    return { allowed: true, override: false, remaining: MAX_CALLS_PER_CASE - placed };
  }

  const reason =
    `this case has already been called ${placed} time${placed === 1 ? '' : 's'} — ` +
    `the limit is ${MAX_CALLS_PER_CASE}`;

  if (facts.override) {
    return { allowed: true, override: true, reason };
  }

  return { allowed: false, reason, overridable: true };
}

/**
 * The words shown in the confirmation, kept next to the rule they describe.
 *
 * Here rather than in the component so the warning cannot drift away from the
 * limit it is warning about — a dialog that says "twice" while the constant
 * says three is worse than no dialog.
 */
export function callLimitWarning(callsPlaced: number): string {
  return (
    `This customer has already been called ${callsPlaced} time${callsPlaced === 1 ? '' : 's'} ` +
    `about this case. The agent stops at ${MAX_CALLS_PER_CASE}. ` +
    `Calling again is your decision and is recorded on the case as one.`
  );
}
