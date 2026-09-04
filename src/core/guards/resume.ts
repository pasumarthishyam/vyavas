/**
 * Which paused cases are still worth waking up.
 *
 * A pause has no known end. Someone can park an account for ten minutes over
 * lunch or for a fortnight while they change payment provider, and the ladder
 * cannot tell the difference until it is over. So resuming is not "carry on
 * where we left off" — it is a decision, taken at the moment of resuming, about
 * whether each parked case is still one a customer would welcome hearing about.
 *
 * The rule that makes it a decision rather than a replay: **a message must be
 * about something the person still remembers doing.** Someone who abandoned a
 * checkout on Monday does not want an email about it on Friday, and sending one
 * is worse than sending nothing — it reads as a system that lost track of
 * itself, which is exactly what happened.
 *
 * Pure. No clock, no database. `now` is passed in, so "what would resuming do
 * to this case next Tuesday" is a table row rather than an experiment.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How old a failure may be and still be worth a first message.
 *
 * Three days, and deliberately shorter than most case deadlines rather than
 * derived from them. The deadline answers "when do we give up on money we have
 * been actively chasing"; this answers "how long can a case sit untouched
 * before waking it up is embarrassing". They are different questions, and the
 * second one has a tighter answer.
 *
 * A `subscription_failure` shows why they cannot be the same number: its
 * deadline is fourteen days, which is right for a ladder that has been
 * messaging and re-presenting all along, and plainly wrong as a licence to send
 * a first message about a charge that failed a fortnight ago.
 */
export const RESUME_MAX_AGE_DAYS = 3;

export type ResumeDisposition =
  /** Wake it up. The ladder starts again at the rung it had reached. */
  | 'resume'
  /** Within its deadline, but the failure is too old to speak about now. */
  | 'too_old'
  /** Its recovery window closed while it was parked. */
  | 'past_deadline';

export interface PausedCaseFacts {
  readonly now: Date;
  /** When the payment failed. Rung offsets and this decision both count from here. */
  readonly createdAt: Date;
  readonly deadlineAt: Date | null;
}

export interface ResumeDecision {
  readonly disposition: ResumeDisposition;
  /** Plain language, shown to the operator in the confirmation overlay. */
  readonly reason: string;
  readonly ageDays: number;
}

export function classifyPausedCase(facts: PausedCaseFacts): ResumeDecision {
  const ageMs = facts.now.getTime() - facts.createdAt.getTime();
  // Floored, so "2.9 days" reads as 2 and the boundary matches the comparison
  // below rather than rounding a case into a bucket it does not belong in.
  const ageDays = Math.max(0, Math.floor(ageMs / DAY_MS));

  // Checked first: a case past its deadline is over regardless of its age, and
  // saying "too old" about it would hide the more specific truth.
  if (facts.deadlineAt !== null && facts.now.getTime() >= facts.deadlineAt.getTime()) {
    return {
      disposition: 'past_deadline',
      reason: 'the recovery window closed while this was paused',
      ageDays,
    };
  }

  if (ageMs > RESUME_MAX_AGE_DAYS * DAY_MS) {
    return {
      disposition: 'too_old',
      reason: `the payment failed ${ageDays} days ago — too long to message about now`,
      ageDays,
    };
  }

  return {
    disposition: 'resume',
    reason:
      ageDays === 0
        ? 'failed today, still worth continuing'
        : `failed ${ageDays} day${ageDays === 1 ? '' : 's'} ago, still worth continuing`,
    ageDays,
  };
}

/** Does this disposition mean the case is closed rather than woken? */
export function isClosing(d: ResumeDisposition): boolean {
  return d !== 'resume';
}
