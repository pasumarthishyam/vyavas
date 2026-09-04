/**
 * Coming back from a pause.
 *
 * A pause parks a case in `paused` and ends its Inngest run. Nothing is
 * sleeping and nothing is waiting on a timer, so resuming is not "unpause a
 * thing that was waiting" — it is starting a fresh run for each parked case.
 *
 * ── why this asks a person ──
 *
 * It used to resume everything automatically the moment an account went live,
 * and that is wrong for a reason that only shows up on a long pause. Rung times
 * are measured from when the payment failed, so a case parked past its rung
 * times fires the instant it is woken. Pause for a week, press Live, and a
 * hundred people hear from you at once about checkouts they abandoned last
 * Tuesday. The merchant did not ask for that; they asked to turn the agent back
 * on.
 *
 * So going live is now a decision with a preview in front of it. `preview()`
 * says exactly what would happen to each parked case and nothing else; `apply()`
 * does it, and only a person calls `apply`.
 *
 * ── and why some cases are never resumed ──
 *
 * A message has to be about something the person still remembers doing. Past
 * `RESUME_MAX_AGE_DAYS` it is not, and waking the case would produce a worse
 * outcome than leaving it alone — so those are closed rather than sent, and
 * closed as `aborted`, because we chose not to treat them rather than tried and
 * failed. See `core/guards/resume.ts`.
 */

import {
  classifyPausedCase,
  type ResumeDisposition,
} from '../core/guards/resume.js';
import type { Database } from '../db/client.js';
import {
  claimPausedCaseForResume,
  closePausedCase,
  listPausedCases,
  listResumableCases,
  repausePausedCase,
  type PausedCaseRow,
} from '../db/repos/cases.js';
import { runKeyFor, type CaseDiagnosedData } from './client.js';
import { publishCaseDiagnosed } from './publish.js';

/**
 * How a woken case reaches the durable engine.
 *
 * An injection point rather than a direct Inngest import, for the same reason
 * `WorkflowPublisher` exists on the ingest path: the whole decision — which
 * cases wake, which close, and what each one is told — is then testable with no
 * workflow engine running, which is where the interesting failures are.
 */
export type ResumePublisher = (data: CaseDiagnosedData) => Promise<unknown>;

export interface PausedCasePreview {
  id: string;
  amountPaise: number;
  causeClass: string | null;
  errorReason: string | null;
  customerContact: string | null;
  messagesSent: number;
  ageDays: number;
  disposition: ResumeDisposition;
  reason: string;
}

export interface ResumePreview {
  paused: number;
  /** Cases that would be woken and would continue their ladder. */
  resumable: number;
  /** Within their deadline, but the failure is too old to speak about. */
  tooOld: number;
  /** Their recovery window closed while parked. */
  pastDeadline: number;
  amountResumablePaise: number;
  amountClosingPaise: number;
  cases: PausedCasePreview[];
}

function describe(row: PausedCaseRow, now: Date): PausedCasePreview {
  const decision = classifyPausedCase({
    now,
    createdAt: row.createdAt,
    deadlineAt: row.deadlineAt,
  });
  return {
    id: row.id,
    amountPaise: row.amountAtRiskPaise,
    causeClass: row.causeClass,
    errorReason: row.errorReason,
    customerContact: row.customerContact,
    messagesSent: row.messagesSent,
    ageDays: decision.ageDays,
    disposition: decision.disposition,
    reason: decision.reason,
  };
}

/**
 * What resuming would do. Reads only — nothing here writes or publishes.
 *
 * This is what the confirmation overlay renders, and it must stay side-effect
 * free: an operator opening a dialog to look at their options must not thereby
 * have taken them.
 */
export async function preview(
  db: Database,
  merchantId: string,
  now = new Date(),
): Promise<ResumePreview> {
  const rows = await listPausedCases(db, merchantId);
  const cases = rows.map((r) => describe(r, now));

  const sum = (d: (c: PausedCasePreview) => boolean) =>
    cases.filter(d).reduce((t, c) => t + c.amountPaise, 0);

  return {
    paused: cases.length,
    resumable: cases.filter((c) => c.disposition === 'resume').length,
    tooOld: cases.filter((c) => c.disposition === 'too_old').length,
    pastDeadline: cases.filter((c) => c.disposition === 'past_deadline').length,
    amountResumablePaise: sum((c) => c.disposition === 'resume'),
    amountClosingPaise: sum((c) => c.disposition !== 'resume'),
    cases,
  };
}

export interface ResumeOutcome {
  examined: number;
  resumed: number;
  /** Closed because they were too old or past their deadline. */
  closed: number;
  /** Claimed by someone else first. Ordinary under a race, not an error. */
  skipped: number;
  errors: string[];
}

/**
 * What to do with the cases that are still worth waking.
 *
 *   'resume'  wake them, and close the ones that are too old anyway
 *   'none'    close everything parked. The operator wants the agent on for NEW
 *             failures without reaching back to anyone who was waiting
 */
export type ResumeChoice = 'resume' | 'none';

/**
 * Wake one case. Returns what happened so the caller can count honestly.
 *
 * `claimPausedCaseForResume` is a conditional UPDATE, so the loser of a race
 * gets null and must do nothing at all — publishing twice would start two
 * ladders on one case, which is two of every remaining message to a person.
 */
async function wake(
  db: Database,
  caseId: string,
  publish: ResumePublisher,
): Promise<'resumed' | 'skipped'> {
  const claimed = await claimPausedCaseForResume(db, caseId);
  if (!claimed) return 'skipped';

  // Unreachable in practice — a case cannot be paused without a stamped policy
  // — but publishing an unrunnable event would strand it in `executing` with
  // nothing behind it, so it is checked rather than assumed.
  if (!claimed.policyId) {
    await repausePausedCase(db, caseId, 'no policy stamped, cannot start a ladder');
    return 'skipped';
  }

  try {
    await publish({
      caseId: claimed.id,
      merchantId: claimed.merchantId,
      causeClass: claimed.causeClass ?? 'unknown',
      policyId: claimed.policyId,
      policyVersion: claimed.policyVersion ?? 1,
      cohort: claimed.cohort === 'holdout' ? 'holdout' : 'treatment',
      attended: claimed.attended,
      // Unique per resume. Under the original key Inngest would swallow this as
      // a duplicate of the run that was paused, and nothing would ever say so.
      runKey: runKeyFor(claimed.id, claimed.resumeCount),
    });
  } catch (e) {
    /*
     * The claim succeeded and the publish did not.
     *
     * Put the case back where it was. Leaving it `executing` would strand it:
     * the state says a ladder is running, no ladder is, and nothing would ever
     * notice — the sweep only looks at `paused`, so the case would sit there
     * until its deadline quietly wrote it off. Re-parking hands it back to the
     * sweep, which retries in fifteen minutes.
     *
     * `resume_count` is deliberately NOT rolled back. It has already been spent
     * as a run key, and reusing it would collide with the run this attempt may
     * yet have started at Inngest before failing.
     */
    await repausePausedCase(
      db,
      caseId,
      `could not start the ladder: ${e instanceof Error ? e.message : String(e)}`,
    );
    throw e;
  }

  return 'resumed';
}

/**
 * Act on a preview.
 *
 * Takes the merchant's parked cases and applies the operator's choice. The
 * classification is recomputed here rather than trusted from the preview the
 * browser was holding: a dialog can sit open for an hour, and a case that was
 * resumable when it was drawn may not be by the time someone presses the button.
 */
export async function apply(
  db: Database,
  merchantId: string,
  choice: ResumeChoice,
  now = new Date(),
  publish: ResumePublisher = publishCaseDiagnosed,
): Promise<ResumeOutcome> {
  const rows = await listPausedCases(db, merchantId);
  const out: ResumeOutcome = {
    examined: rows.length,
    resumed: 0,
    closed: 0,
    skipped: 0,
    errors: [],
  };

  for (const row of rows) {
    try {
      const decision = classifyPausedCase({
        now,
        createdAt: row.createdAt,
        deadlineAt: row.deadlineAt,
      });

      const shouldWake = choice === 'resume' && decision.disposition === 'resume';

      if (shouldWake) {
        const r = await wake(db, row.id, publish);
        if (r === 'resumed') out.resumed++;
        else out.skipped++;
        continue;
      }

      const reason =
        decision.disposition === 'past_deadline'
          ? ('deadline_passed' as const)
          : decision.disposition === 'too_old'
            ? ('stale_after_pause' as const)
            : // The operator chose not to reach back to anyone. A deliberate
              // stop, recorded as one.
              ('manual_abort' as const);

      const closed = await closePausedCase(
        db,
        row.id,
        reason,
        choice === 'none' && decision.disposition === 'resume'
          ? 'the operator resumed the agent without reaching back to waiting cases'
          : decision.reason,
      );
      if (closed) out.closed++;
      else out.skipped++;
    } catch (e) {
      // One case failing must not strand the rest. Whatever is still parked is
      // picked up by the sweep.
      out.errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return out;
}

/**
 * The backstop, across every live merchant.
 *
 * Runs on the sweep for a flag changed some other way — the CLI, direct SQL, or
 * a switch whose request died after the UPDATE and before the resume. It
 * applies the SAME classification as the console path, so a case resumed by the
 * sweep and a case resumed by the button are treated identically, and a case
 * too old for one is too old for the other.
 *
 * It resumes rather than closes on the `resume` disposition, because reaching
 * this code means an account IS live and nobody declined to wake its cases —
 * the decline path only exists where a person made it.
 */
export async function resumeAllLiveMerchants(
  db: Database,
  limit = 200,
  now = new Date(),
  publish: ResumePublisher = publishCaseDiagnosed,
): Promise<ResumeOutcome> {
  const rows = await listResumableCases(db, limit);
  const out: ResumeOutcome = {
    examined: rows.length,
    resumed: 0,
    closed: 0,
    skipped: 0,
    errors: [],
  };

  for (const row of rows) {
    try {
      const decision = classifyPausedCase({
        now,
        createdAt: row.createdAt,
        deadlineAt: row.deadlineAt,
      });

      if (decision.disposition === 'resume') {
        const r = await wake(db, row.id, publish);
        if (r === 'resumed') out.resumed++;
        else out.skipped++;
        continue;
      }

      const closed = await closePausedCase(
        db,
        row.id,
        decision.disposition === 'past_deadline' ? 'deadline_passed' : 'stale_after_pause',
        decision.reason,
      );
      if (closed) out.closed++;
      else out.skipped++;
    } catch (e) {
      out.errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return out;
}
