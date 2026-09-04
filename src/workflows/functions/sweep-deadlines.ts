/**
 * The deadline sweep.
 *
 * A ladder finishing is not the same as a case ending: a customer can still pay
 * after the last rung, and until the deadline passes the case is legitimately
 * still open. Something has to close those, and it cannot be the ladder — the
 * ladder has already returned.
 *
 * Runs on a schedule rather than as a per-case timer because a case can also
 * become stale in ways no ladder is watching: the merchant disconnects, the
 * workflow crashes mid-run, a deploy loses an in-flight sleep. This is the
 * backstop that makes "no case stays open forever" true rather than hoped for.
 */

import { inngest } from '../client.js';
import { getDb } from '../../db/client.js';
import {
  claimExpiredCases,
  listCasesAwaitingLinkPayment,
  transitionCase,
} from '../../db/repos/cases.js';
import { isPaymentLinkPaid } from '../../adapters/razorpay/resources.js';
import { reconcileCaseLinkPaid } from '../../ingest/handlers/payment-link.js';
import { redriveWebhooks } from '../../ingest/redrive.js';
import { razorpayForMerchant } from '../merchant-clients.js';
import { workflowPublisher } from '../publish.js';
import { resumeAllLiveMerchants } from '../resume.js';

interface SweepSteps {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export const sweepDeadlines = inngest.createFunction(
  {
    id: 'sweep-deadlines',
    triggers: [{ cron: '*/15 * * * *' }, { event: 'sweep/requested' }],
    // One sweep at a time. Two concurrent runs would race on the same expired
    // cases, and `FOR UPDATE SKIP LOCKED` would let both do half the work.
    concurrency: [{ limit: 1 }],
  },
  async ({ step }: { step: SweepSteps }) => {
    const db = getDb();

    /*
     * Confirm recovery links BEFORE anything is written off.
     *
     * Order matters and this step has to be first. A customer who pays on the
     * recovery link an hour before the deadline produces no `order.paid` — the
     * link creates its own order — so if the expiry pass ran first it would
     * mark that case `lost`, and `lost` is terminal. The money would have
     * arrived, the merchant would have been told it did not, and nothing could
     * correct it afterwards.
     *
     * This is the backstop for a missed `payment_link.paid` delivery. The
     * webhook is the fast path and normally wins; this runs every fifteen
     * minutes whether or not it arrived.
     */
    const linksResult = await step.run('reconcile-payment-links', async () => {
      const pending = await listCasesAwaitingLinkPayment(db, 200);

      let recovered = 0;
      const errors: string[] = [];
      // One client per merchant per sweep, not one per row.
      const clients = new Map<string, Awaited<ReturnType<typeof razorpayForMerchant>>>();

      for (const row of pending) {
        try {
          if (!row.rzpPaymentLinkId) continue;

          let razorpay = clients.get(row.merchantId);
          if (razorpay === undefined) {
            razorpay = await razorpayForMerchant(db, row.merchantId);
            clients.set(row.merchantId, razorpay);
          }
          if (!razorpay) continue;

          const link = await isPaymentLinkPaid(razorpay, row.rzpPaymentLinkId);
          if (!link.paid) continue;

          const closed = await reconcileCaseLinkPaid(
            {
              db,
              merchantId: row.merchantId,
              now: new Date(),
              // Cohort assignment already happened at ingest; these are unused
              // on this path and are here only to satisfy the shared context.
              holdoutBasisPoints: 0,
              holdoutEnabled: false,
            },
            row.id,
            row.rzpPaymentLinkId,
            link.amountPaidPaise > 0 ? link.amountPaidPaise : Number(row.amountAtRiskPaise),
          );

          if (closed) {
            recovered++;
            // Kill the ladder wherever it is sleeping, the same way the webhook
            // does. Without this the run keeps its remaining sleeps and only
            // stops at the next rung's gate.
            await workflowPublisher.caseResolved({
              caseId: row.id,
              merchantId: row.merchantId,
              outcome: 'recovered',
              reason: 'payment_link_reconciled',
            });
          }
        } catch (e) {
          errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return { examined: pending.length, recovered, errors };
    });

    /*
     * Restart cases parked by a pause whose merchant is live again.
     *
     * The switch in `/api/recovery/execution` already does this the instant
     * someone presses it. This is the backstop for every other way the flag can
     * change — the merchant CLI, direct SQL, or a switch whose request died
     * after the UPDATE and before the publish.
     *
     * Before the expiry pass below, for the same reason the link reconciliation
     * is: a case that was paused close to its deadline deserves its remaining
     * runway, not to be written off in the same run that could have restarted
     * it.
     *
     * Racing the switch is harmless. The claim is a conditional UPDATE, so
     * whichever gets there first takes the case and the other sees nothing.
     */
    const resumedResult = await step.run('resume-paused', async () =>
      resumeAllLiveMerchants(db, 200, new Date()),
    );

    const expiredResult = await step.run('close-expired', async () => {
      const expired = await claimExpiredCases(db, 50);
      const closed: string[] = [];

      for (const c of expired) {
        // `lost`, not `aborted`: we tried and ran out of runway. Aborted means
        // we stopped deliberately, and the incrementality report must not
        // count a case we abandoned as one the treatment failed to recover.
        const r = await transitionCase(db, c.id, 'lost', 'deadline_passed', { actor: 'sweep' });
        if (r.ok) closed.push(c.id);
      }

      return { examined: expired.length, closed: closed.length };
    });

    /*
     * Recover deliveries that were claimed and then lost.
     *
     * This is the sweep that half the ingest path's comments already refer to
     * and that did not exist. It belongs here rather than in its own function
     * for the same reason the deadline pass does: both are backstops for work
     * that was supposed to happen elsewhere and didn't, and both want the same
     * every-fifteen-minutes cadence.
     *
     * A separate step so a failure in one half cannot roll back the other —
     * closing expired cases must not depend on a poison webhook payload.
     */
    const redriveResult = await step.run('redrive-webhooks', async () =>
      redriveWebhooks({ db, publish: workflowPublisher }),
    );

    return {
      paymentLinks: linksResult,
      resumed: resumedResult,
      expired: expiredResult,
      redrive: redriveResult,
    };
  },
);
