/**
 * The ladder workflow.
 *
 * One durable run per case. It sleeps for hours between rungs, races those
 * sleeps against the case being resolved, and re-gathers every fact before each
 * step — because the world moves while a case sleeps.
 *
 * What Inngest is actually buying us here, and why a cron loop would not do:
 *
 *   - `step.sleepUntil` survives deploys. A case parked for 26 hours does not
 *     care that we shipped twice in the meantime.
 *   - `step.waitForEvent` lets a payment arriving at hour 3 cancel a rung
 *     scheduled for hour 6, without polling.
 *   - Every `step.run` is memoised, so a retry replays completed steps rather
 *     than re-executing them. That is the difference between a retry and a
 *     second message.
 *
 * The workflow itself contains NO business logic. It sequences steps and hands
 * the decisions to `evaluatePreconditions` and `executeRung`.
 */

import { NonRetriableError } from 'inngest';
import { eq } from 'drizzle-orm';

import { recoveryCases } from '../../db/schema/cases.js';

import { parseDuration } from '../../core/policy/duration.js';
import { POLICY_TABLE } from '../../core/policy/index.js';
import { appendEvent, transitionCase } from '../../db/repos/cases.js';
import { getDb } from '../../db/client.js';
import { gatherFacts } from '../facts.js';
import { executeRung } from '../executor.js';
import { razorpayForMerchant } from '../merchant-clients.js';
import { inngest, type CaseDiagnosedData } from '../client.js';
import { closeCaseFromGate, loadCaseForRun } from '../case-run.js';

/**
 * The subset of Inngest step tools this workflow uses.
 *
 * Declared narrowly rather than inferred: the SDK generic threads client and
 * middleware types through several layers, and pinning to it makes an SDK
 * upgrade a compile error in the workflow rather than at the boundary. This
 * also documents exactly which durable primitives the ladder depends on.
 */
interface LadderSteps {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleepUntil(id: string, at: Date): Promise<unknown>;
}

/**
 * How many times one rung may be deferred before the ladder gives up on it.
 *
 * A safety rail against a gate that keeps naming the same instant, not a
 * judgement about how long a customer is worth waiting for — the case deadline
 * is what answers that. With an accurate `retryAt` a real deferral clears in one
 * or two waits, so reaching this limit means something is wrong with the gate
 * and the `rung_abandoned` event is there to say so.
 */
const MAX_DEFERRALS_PER_RUNG = 12;

export const runLadder = inngest.createFunction(
  {
    id: 'run-ladder',
    triggers: [{ event: 'case/diagnosed' }],
    /*
     * One run per RUN KEY, ever. Without this a duplicate `case/diagnosed`
     * would start a second ladder against the same case and double every
     * message.
     *
     * Keyed on `runKey` rather than `caseId` so a case can legitimately run
     * again after being paused. The key is the case id on a first run and
     * `<caseId>:r<n>` on the nth resume, so a duplicate of either is still
     * refused while a genuine resume is not. Keying on the case id alone made
     * resume impossible: the republished event was swallowed by this guard and
     * the case sat in `executing` with no run behind it.
     */
    idempotency: 'event.data.runKey',
    // Per-merchant concurrency, so one merchant's outage burst cannot starve
    // every other tenant's workflows.
    //
    // 5, because that is the Inngest free plan's per-function ceiling and a
    // function declaring more is REJECTED AT SYNC — the whole app fails to
    // register, with `400 The function 'run-ladder' has higher concurrency
    // limits (25) than your plan limit of 5` returned to a sync that then
    // retries every five seconds forever. Nothing about the failure points at
    // this line unless you read the sync response body.
    //
    // Raise it in step with the plan; it is a throughput ceiling, not a
    // correctness one — the durable steps and the idempotency keys are what
    // keep concurrent runs safe.
    concurrency: [{ key: 'event.data.merchantId', limit: 5 }],
    // A case ending cancels the run immediately, wherever it is sleeping. This
    // is the kill switch, and it is declarative rather than a check we might
    // forget somewhere.
    cancelOn: [{ event: 'case/resolved', match: 'data.caseId' }],
    retries: 3,
  },
  async ({ event, step }: { event: { data: unknown }; step: LadderSteps }) => {
    const data = event.data as unknown as CaseDiagnosedData;
    const { caseId, merchantId } = data;

    const policy = POLICY_TABLE.find((p) => p.id === data.policyId);
    if (!policy) {
      // A missing policy is a table defect, not a transient failure — retrying
      // cannot conjure it back.
      throw new NonRetriableError(
        `Policy '${data.policyId}' is not in the compiled table. The case was stamped with a row that no longer exists.`,
      );
    }

    if (policy.ladder.length === 0) {
      // Terminal classes legitimately do nothing. `order_already_paid` must
      // never reach a rung.
      return { caseId, outcome: 'no_ladder', rungs: 0 };
    }

    const db = getDb();

    // Move to executing once, at the start.
    await step.run('mark-executing', async () => {
      const r = await transitionCase(db, caseId, 'executing', 'ladder_started', {
        actor: 'workflow',
      });
      return { ok: r.ok, reason: r.reason };
    });

    const detectedAt = await step.run('load-case', async () => {
      const c = await loadCaseForRun(db, caseId);
      if (!c) throw new NonRetriableError(`Case ${caseId} disappeared`);
      return {
        createdAt: c.createdAt.toISOString(),
        deadlineAt: c.deadlineAt?.toISOString() ?? null,
        rails: c.rails,
        retry: c.sameInstrumentRetry,
      };
    });

    const start = new Date(detectedAt.createdAt).getTime();
    // Past this instant the case is closed by the deadline sweep, so waiting
    // beyond it is waiting for nothing.
    const deadline = detectedAt.deadlineAt ? new Date(detectedAt.deadlineAt).getTime() : null;
    const results: unknown[] = [];

    /** One attempt at rung `i`. Identical on the first try and every retry. */
    const attempt = async (i: number, rung: (typeof policy.ladder)[number], stepId: string) =>
      step.run(stepId, async () => {
        const gathered = await gatherFacts({ db, caseId, now: new Date() });
        // Every field the normal return carries, so the two shapes are one type
        // and the abort branch below can read `failed` without narrowing.
        if (!gathered) {
          return {
            disposition: 'aborted' as const,
            note: 'case vanished',
            suppressedReason: null,
            channel: null,
            retryAt: null,
            failed: null,
            paidAmountPaise: null,
            paidConfirmed: false,
          };
        }

        // This merchant's own account. Resolved here rather than inside the
        // executor: the workflow is where the merchant is unambiguous, and an
        // absent credential must mean "no link", never "use whatever key the
        // environment happens to hold".
        const razorpay = await razorpayForMerchant(db, merchantId);

        const r = await executeRung({
          db,
          caseId,
          merchantId,
          rungIndex: i,
          rung,
          policy,
          gathered,
          cohort: data.cohort,
          diagnosisRails: detectedAt.rails,
          sameInstrumentRetry: detectedAt.retry,
          ...(razorpay ? { razorpay } : {}),
        });

        return {
          disposition: r.disposition,
          note: r.note,
          suppressedReason: r.suppressedReason,
          channel: r.channel,
          retryAt: r.retryAt?.toISOString() ?? null,
          // Carried out of the step so the abort branch below can end the case
          // in the state that is actually true. Without it every abort looked
          // identical and was recorded as `already_paid`.
          failed: r.gate.failed,
          paidAmountPaise: gathered.paidAmountPaise,
          paidConfirmed: gathered.paidConfirmed,
        };
      });

    for (let i = 0; i < policy.ladder.length; i++) {
      const rung = policy.ladder[i]!;

      // Offsets are from DETECTION, not from the previous rung — so a rung that
      // was deferred does not push everything after it down the line.
      const fireAt = new Date(start + parseDuration(rung.at));

      if (fireAt.getTime() > Date.now()) {
        await step.sleepUntil(`wait-rung-${i}`, fireAt);
      }

      let outcome = await attempt(i, rung, `rung-${i}`);
      results.push({ rung: i, ...outcome });

      /*
       * The merchant paused the agent while this case was in flight.
       *
       * Park it and end the run. NOT an abort — the case keeps its rung, its
       * deadline and its ledger, and `claimPausedCaseForResume` starts a fresh
       * run from exactly here when someone switches the account back to live.
       *
       * Ending the run rather than sleeping is deliberate. A pause has no known
       * end, so a durable run waiting one out would either wake uselessly for
       * weeks or exhaust its deferral budget and abandon a case that was only
       * ever paused.
       */
      if (outcome.disposition === 'paused') {
        await step.run(`pause-${i}`, async () => {
          const moved = await transitionCase(db, caseId, 'paused', 'paused_by_merchant', {
            actor: 'workflow',
          });
          await appendEvent(db, {
            caseId,
            merchantId,
            kind: 'ladder_paused',
            reason: 'execution_paused',
            actor: 'workflow',
            payload: { rung: i, moved: moved.ok },
          });
          return { paused: moved.ok };
        });
        return { caseId, outcome: 'paused', at: i, results };
      }

      /**
       * Wait out a deferral for as long as the case is alive.
       *
       * A deferral means "not right now", and the gate says exactly when to ask
       * again. The only honest reasons to stop asking are that the case is over
       * or that the gate has stopped giving a time.
       *
       * This used to allow exactly ONE retry, on the reasoning that a rung
       * should not stall the ladder behind a quiet-hours window. That reasoning
       * was inverted: moving on does not un-stall anything, it abandons the
       * touch entirely. A real case sat with the frequency cap clearing three
       * hours out, was deferred twice against a flat one-hour guess, and the
       * ladder walked away 57 minutes early having sent nothing — no message,
       * no alert, and a case left mid-flight. Waiting is what a ladder is for.
       *
       * The counter is a safety rail against a gate that defers to the same
       * instant forever, not a policy choice; with an accurate `retryAt` a real
       * deferral resolves in one or two waits.
       */
      for (let deferral = 1; outcome.disposition === 'deferred' && outcome.retryAt; deferral++) {
        const retryAt = new Date(outcome.retryAt).getTime();

        if (deadline !== null && retryAt >= deadline) {
          await step.run(`rung-${i}-past-deadline`, async () => {
            await appendEvent(db, {
              caseId,
              merchantId,
              kind: 'rung_abandoned',
              reason: 'deferred_past_deadline',
              actor: 'workflow',
              payload: { rung: i, note: outcome.note, retryAt: outcome.retryAt },
            });
            return { abandoned: true };
          });
          results.push({ rung: i, abandoned: 'deferred_past_deadline' });
          break;
        }

        if (deferral > MAX_DEFERRALS_PER_RUNG) {
          await step.run(`rung-${i}-defer-exhausted`, async () => {
            await appendEvent(db, {
              caseId,
              merchantId,
              kind: 'rung_abandoned',
              reason: 'deferral_limit',
              actor: 'workflow',
              payload: { rung: i, note: outcome.note, deferrals: MAX_DEFERRALS_PER_RUNG },
            });
            return { abandoned: true };
          });
          results.push({ rung: i, abandoned: 'deferral_limit' });
          break;
        }

        await step.sleepUntil(`defer-rung-${i}-${deferral}`, new Date(retryAt));
        outcome = await attempt(i, rung, `rung-${i}-retry-${deferral}`);
        results.push({ rung: i, retry: deferral, ...outcome });
      }

      if (outcome.disposition === 'aborted') {
        /*
         * End the case as what it actually is.
         *
         * This branch used to hard-code `aborted` / `already_paid` for every
         * abort the gate could produce. The money arriving, the deadline
         * passing and the customer opting out all landed in the same state
         * with the same reason, and a case whose payment link had just been
         * paid was recorded as an abort with no recovered amount against it —
         * so the one outcome this product exists to produce was the one it
         * could not report. See `closeCaseFromGate`.
         */
        const closed = await step.run(`close-${i}`, async () =>
          closeCaseFromGate(db, {
            caseId,
            merchantId,
            failed: outcome.failed,
            note: outcome.note,
            paidAmountPaise: outcome.paidAmountPaise,
            paidConfirmed: outcome.paidConfirmed,
          }),
        );
        return { caseId, outcome: closed.outcome, reason: closed.reason, at: i, results };
      }
    }

    // The ladder ran out. Not a failure — the deadline sweep decides whether
    // this becomes `lost`, because a case can still be paid after the last rung.
    //
    // Recorded explicitly so a case that ends up sending nothing says so in its
    // own timeline. Reading `state = executing` and an empty message log and
    // inferring "the ladder finished" is exactly the guess this event removes.
    const completion = await step.run('ladder-complete', async () => {
      /*
       * Why it ended, not just that it did.
       *
       * "Ladder complete" is true of a case that said everything its class
       * permits AND of one that was never able to say anything at all, and the
       * console could not tell them apart — both rendered as the same grey
       * line. `ceiling_reached` is the one a merchant actually needs to see: it
       * means the agent is finished with this customer by design, and any
       * further contact is a decision for a person.
       *
       * Counted from the case's own `messages_sent`, which the executor
       * increments per message (a fanout pair counts as two), against the
       * policy row's declared ceiling.
       */
      const [row] = await db
        .select({ sent: recoveryCases.messagesSent })
        .from(recoveryCases)
        .where(eq(recoveryCases.id, caseId))
        .limit(1);

      const sent = Number(row?.sent ?? 0);
      const reason = sent >= policy.maxMessages && policy.maxMessages > 0
        ? 'ceiling_reached'
        : 'ladder_exhausted';

      await appendEvent(db, {
        caseId,
        merchantId,
        kind: 'ladder_complete',
        reason,
        actor: 'workflow',
        payload: {
          rungs: policy.ladder.length,
          messagesSent: sent,
          maxMessages: policy.maxMessages,
          results,
        },
      });
      return { reason, sent };
    });

    return {
      caseId,
      outcome: 'ladder_complete',
      reason: completion.reason,
      rungs: policy.ladder.length,
      results,
    };
  },
);
