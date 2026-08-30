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
import { claimExpiredCases, transitionCase } from '../../db/repos/cases.js';
import { redriveWebhooks } from '../../ingest/redrive.js';
import { workflowPublisher } from '../publish.js';

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

    return { expired: expiredResult, redrive: redriveResult };
  },
);
