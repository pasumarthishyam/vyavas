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

import { parseDuration } from '../../core/policy/duration.js';
import { POLICY_TABLE } from '../../core/policy/index.js';
import { transitionCase } from '../../db/repos/cases.js';
import { getDb } from '../../db/client.js';
import { gatherFacts } from '../facts.js';
import { executeRung } from '../executor.js';
import { razorpayForMerchant } from '../merchant-clients.js';
import { inngest, type CaseDiagnosedData } from '../client.js';
import { loadCaseForRun } from '../case-run.js';

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

export const runLadder = inngest.createFunction(
  {
    id: 'run-ladder',
    triggers: [{ event: 'case/diagnosed' }],
    // One run per case, ever. Without this a duplicate `case/diagnosed` would
    // start a second ladder against the same case and double every message.
    idempotency: 'event.data.caseId',
    // Per-merchant concurrency, so one merchant's outage burst cannot starve
    // every other tenant's workflows.
    concurrency: [{ key: 'event.data.merchantId', limit: 25 }],
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
      return { createdAt: c.createdAt.toISOString(), rails: c.rails, retry: c.sameInstrumentRetry };
    });

    const start = new Date(detectedAt.createdAt).getTime();
    const results: unknown[] = [];

    for (let i = 0; i < policy.ladder.length; i++) {
      const rung = policy.ladder[i]!;

      // Offsets are from DETECTION, not from the previous rung — so a rung that
      // was deferred does not push everything after it down the line.
      const fireAt = new Date(start + parseDuration(rung.at));

      if (fireAt.getTime() > Date.now()) {
        await step.sleepUntil(`wait-rung-${i}`, fireAt);
      }

      const outcome = await step.run(`rung-${i}`, async () => {
        const gathered = await gatherFacts({ db, caseId, now: new Date() });
        if (!gathered) return { disposition: 'aborted' as const, note: 'case vanished' };

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
        };
      });

      results.push({ rung: i, ...outcome });

      if (outcome.disposition === 'aborted') {
        await step.run(`abort-${i}`, async () => {
          await transitionCase(db, caseId, 'aborted', 'already_paid', { actor: 'workflow' });
          return { aborted: true };
        });
        return { caseId, outcome: 'aborted', at: i, results };
      }

      // A deferred rung waits and tries once more. It does not retry forever:
      // if the reason is still true after one wait, the ladder moves on rather
      // than stalling the whole case behind a quiet-hours window.
      if (outcome.disposition === 'deferred' && outcome.retryAt) {
        await step.sleepUntil(`defer-rung-${i}`, new Date(outcome.retryAt));

        const retry = await step.run(`rung-${i}-retry`, async () => {
          const gathered = await gatherFacts({ db, caseId, now: new Date() });
          if (!gathered) return { disposition: 'aborted' as const, note: 'case vanished' };
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
          return { disposition: r.disposition, note: r.note };
        });

        results.push({ rung: i, retry: true, ...retry });

        if (retry.disposition === 'aborted') {
          await step.run(`abort-retry-${i}`, async () => {
            await transitionCase(db, caseId, 'aborted', 'already_paid', { actor: 'workflow' });
            return { aborted: true };
          });
          return { caseId, outcome: 'aborted', at: i, results };
        }
      }
    }

    // The ladder ran out. Not a failure — the deadline sweep decides whether
    // this becomes `lost`, because a case can still be paid after the last rung.
    return { caseId, outcome: 'ladder_complete', rungs: policy.ladder.length, results };
  },
);
