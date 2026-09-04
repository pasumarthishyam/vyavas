/**
 * Reprocess webhook deliveries that were claimed and then stranded.
 *
 *   npx tsx scripts/redrive.ts            # what is stuck, and process it
 *   npx tsx scripts/redrive.ts --dry      # only say what is stuck
 *   npx tsx scripts/redrive.ts --older=30 # seconds; default 180
 *
 * ── the failure this exists for ──
 *
 * The webhook endpoint CLAIMS a delivery before processing it, which is what
 * makes an at-least-once delivery safe to receive twice. The cost is that the
 * claim outlives the thing that made it: if the process dies between the claim
 * and `markWebhookProcessed`, the row sits marked as seen, dedupe turns
 * Razorpay's own retry into a no-op, and the event is lost silently — no error
 * recorded, because whatever would have recorded one died too.
 *
 * `sweep-deadlines` already redrives every fifteen minutes in production. This
 * is the same call, on demand, for the two cases that cron does not cover: a
 * deployment where Inngest is not running, and the moment after a fix ships
 * when you want the backlog cleared now rather than at the next tick.
 *
 * ── why it takes no publisher by default ──
 *
 * Reprocessing a `payment.failed` republishes `case/diagnosed`, which starts a
 * ladder. Run from a terminal that is not the app, that would start ladders
 * against whatever Inngest the environment happens to point at. `--publish`
 * asks for it explicitly; without it the ingest decisions are made and written
 * and no workflow is started, which is what you want when clearing a backlog of
 * SUCCESS events (`order.paid`, `payment_link.paid`) that only ever close cases.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { sql } from 'drizzle-orm';

import { createClient } from '../src/db/client.js';
import { redriveWebhooks } from '../src/ingest/redrive.js';
import { workflowPublisher } from '../src/workflows/publish.js';

const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(`--${n}`);
const num = (n: string, d: number) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  const v = hit ? Number(hit.slice(n.length + 3)) : NaN;
  return Number.isFinite(v) ? v : d;
};

const { db, sql: raw } = createClient({ max: 1 });

interface Row {
  [k: string]: unknown;
}
const rows = (r: unknown): Row[] =>
  Array.isArray(r) ? (r as Row[]) : (((r as { rows?: Row[] }).rows ?? []) as Row[]);

async function main(): Promise<void> {
  const olderThanSeconds = num('older', 180);

  const stuck = rows(
    await db.execute(sql`
      select w.event_id, w.event_type, w.received_at, w.attempts, w.merchant_id, m.slug
      from webhook_events w
      left join merchants m on m.id = w.merchant_id
      where w.processed_at is null
        and w.received_at < now() - make_interval(secs => ${olderThanSeconds})
      order by w.received_at
      limit 50
    `),
  );

  if (stuck.length === 0) {
    console.log(`\n  Nothing stranded older than ${olderThanSeconds}s.\n`);
    return;
  }

  console.log(`\n  ${stuck.length} stranded deliver${stuck.length === 1 ? 'y' : 'ies'}:\n`);
  for (const w of stuck) {
    console.log(
      `    ${String(w.event_type).padEnd(26)} ${String(w.slug ?? '(no merchant)').padEnd(14)} ` +
        `${String(w.received_at).slice(0, 19)}  attempts=${w.attempts}`,
    );
  }

  if (has('dry')) {
    console.log('\n  --dry: nothing was reprocessed.\n');
    return;
  }

  const result = await redriveWebhooks({
    db,
    olderThanSeconds,
    limit: 50,
    // Off unless asked. See the header note.
    ...(has('publish') ? { publish: workflowPublisher } : {}),
  });

  console.log(
    `\n  reprocessed ${result.reprocessed} · failed ${result.failed} · skipped ${result.skipped}`,
  );
  if (!has('publish')) {
    console.log('  (no ladders started — pass --publish to republish diagnosed failures)');
  }
  console.log('');
}

main()
  .then(async () => {
    await raw.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    await raw.end({ timeout: 5 });
    process.exit(1);
  });
