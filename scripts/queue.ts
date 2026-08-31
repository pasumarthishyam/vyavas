/**
 * The escalation queue.
 *
 *   npm run queue                          everything open
 *   npm run queue -- --queue=risk_review
 *   npm run queue -- --merchant=<uuid>
 *   npm run queue -- --ack=<id> --by=shyam
 *   npm run queue -- --resolve=<id> --note="customer paid by NEFT"
 *   npm run queue -- --dismiss=<id> --note="duplicate of ORD-771"
 *   npm run queue -- --escalate=<caseId>   put a real case in the queue now
 *
 * ── verifying the AI by hand ──
 *
 * `--escalate` is the manual test. It takes a real case, reads its real ledger,
 * asks Claude for a brief, and writes the queue row — the exact path the ladder
 * takes when a policy rung escalates, minus the waiting. The output says
 * whether the brief came from the model or the fallback, and the row appears in
 * the console's "Needs a person" panel with the same provenance badge.
 *
 * It is safe to run: no customer is contacted, and the row can be dismissed.
 *
 * This is the queue that `escalate_to_human` never had. Before it, the action
 * wrote a `case_actions` row with a static note and nothing read it — so
 * `risk.payment_risk_check_failed` escalated to `risk_review` and nobody was
 * ever told.
 *
 * A terminal view rather than a dashboard page: the app is deliberately
 * read-only and acknowledging a case is a write. Putting it here keeps that
 * boundary intact while the queue is still small enough for one person.
 */

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv();

import { eq } from 'drizzle-orm';

import { createClient } from '../src/db/client.js';
import { formatINR, type Paise } from '../src/core/money.js';
import { ESCALATION_QUEUES, type EscalationQueue } from '../src/core/actions/types.js';
import { recoveryCases } from '../src/db/schema/cases.js';
import {
  acknowledgeEscalation,
  closeEscalation,
  listOpenEscalations,
} from '../src/db/repos/escalations.js';
import { escalateCase } from '../src/ops/escalation.js';
import { die, flag } from './lib.js';

const inr = (p: number) => formatINR(p as Paise, { compact: true });

function isQueue(v: string | undefined): v is EscalationQueue {
  return v !== undefined && (ESCALATION_QUEUES as readonly string[]).includes(v);
}

async function main(): Promise<void> {
  const { db, sql: raw } = createClient({ max: 2 });

  try {
    const escalate = flag('escalate');
    if (escalate) {
      const [row] = await db
        .select({ id: recoveryCases.id, merchantId: recoveryCases.merchantId })
        .from(recoveryCases)
        .where(eq(recoveryCases.id, escalate))
        .limit(1);

      if (!row) {
        console.error(`  No case ${escalate}. List them with: npm run queue`);
        process.exitCode = 1;
        return;
      }

      const queue = flag('queue');
      console.log('\n  Reading the case and asking Claude for a brief…');

      const r = await escalateCase({
        db,
        caseId: row.id,
        merchantId: row.merchantId,
        queue: isQueue(queue) ? queue : 'merchant_review',
        // A rung number outside the ladder's own range, so a manual escalation
        // can never collide with the idempotency key of a real rung and
        // suppress the automated one later.
        rung: 99,
        idempotencyKey: `${row.id}:99:escalate_to_human`,
        policyNote: 'Escalated by hand from the console script.',
        now: new Date(),
        // Named in the audit trail, so a hand-run escalation is never mistaken
        // for one the ladder decided on.
        actor: 'console',
      });

      if (!r.created && r.briefError === 'case not found') {
        console.error(`  ${r.briefError}`);
        process.exitCode = 1;
        return;
      }

      console.log(
        r.created
          ? `\n  Queued. Brief written by: ${r.briefSource.toUpperCase()}` +
              (r.briefError ? `\n  Reason for fallback: ${r.briefError}` : '')
          : `\n  This case was already escalated by hand — nothing written.`,
      );
      console.log(`\n  See it: npm run queue     ·  or the "Needs a person" panel at /recovery\n`);
      return;
    }

    const ack = flag('ack');
    const resolve = flag('resolve');
    const dismiss = flag('dismiss');

    if (ack) {
      const by = flag('by');
      if (!by) {
        console.error('  --ack needs --by=<name>: an unassigned acknowledgement helps nobody.');
        process.exitCode = 1;
        return;
      }
      const ok = await acknowledgeEscalation(db, ack, by);
      console.log(ok ? `  Acknowledged by ${by}.` : '  Not found, or no longer open.');
      return;
    }

    if (resolve || dismiss) {
      const id = (resolve ?? dismiss)!;
      const note = flag('note');
      if (!note) {
        console.error('  --resolve and --dismiss need --note="what happened".');
        process.exitCode = 1;
        return;
      }
      const ok = await closeEscalation(db, id, resolve ? 'resolved' : 'dismissed', note);
      console.log(ok ? `  Marked ${resolve ? 'resolved' : 'dismissed'}.` : '  Not found, or already closed.');
      return;
    }

    const queue = flag('queue');
    if (queue !== undefined && !isQueue(queue)) {
      console.error(`  Unknown queue '${queue}'. One of: ${ESCALATION_QUEUES.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    const merchantId = flag('merchant');
    const open = await listOpenEscalations(db, {
      ...(merchantId ? { merchantId } : {}),
      ...(isQueue(queue) ? { queue } : {}),
    });

    console.log(`\n  Open escalations: ${open.length}`);
    console.log('  ' + '─'.repeat(72));

    if (open.length === 0) {
      console.log('  Nothing waiting on a person.\n');
      return;
    }

    for (const e of open) {
      const age = Math.floor((Date.now() - e.createdAt.getTime()) / 60_000);
      console.log(
        `\n  ${e.headline}\n` +
          `    ${e.queue} · ${e.status}${e.assignedTo ? ` (${e.assignedTo})` : ''} · ` +
          `${inr(e.amountAtRiskPaise)} · ${e.causeClass ?? 'unclassified'} · ${age}m old`,
      );
      if (e.whatHappened) console.log(`    happened:  ${e.whatHappened}`);
      if (e.whatWeTried) console.log(`    we tried:  ${e.whatWeTried}`);
      if (e.whatIsBlocking) console.log(`    blocking:  ${e.whatIsBlocking}`);
      if (e.recommendedAction) {
        // Labelled every time. This is advice to the reader; nothing automated
        // consumes it, and it must never read like an instruction the system
        // is waiting to be given.
        console.log(`    SUGGESTION (advice only, not acted on): ${e.recommendedAction}`);
      }
      console.log(
        `    brief: ${e.briefSource}${e.briefConfidence ? ` · ${e.briefConfidence} confidence` : ''}`,
      );
      console.log(`    case ${e.caseId}\n    id   ${e.id}`);
    }

    console.log(
      `\n  Acknowledge: npm run queue -- --ack=<id> --by=<name>\n` +
        `  Close:       npm run queue -- --resolve=<id> --note="…"\n`,
    );
  } finally {
    await raw.end({ timeout: 5 });
  }
}

main().catch(die);
