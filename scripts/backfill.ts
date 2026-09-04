/**
 * Pull real payment history from a Razorpay account into the system.
 *
 *   npm run backfill -- --account=TRADESMETRIX --days=180
 *   npm run backfill -- --account=TRADESMETRIX --reset
 *
 * Reads `<ACCOUNT>_RAZORPAY_API_KEY` and `<ACCOUNT>_RAZORPAY_API_SECRET` from
 * `.env.local`, so several accounts can coexist without one clobbering another.
 *
 * READ-ONLY against Razorpay. It fetches payments and nothing else — no links
 * created, no refunds, no writes of any kind. Every failure it finds goes
 * through the REAL `processEvent`, the same function the webhook calls, so the
 * diagnosis you see is the diagnosis production would produce.
 *
 * The merchant row it creates keeps the safe default: `execution_enabled`
 * false, which means PAUSED. Backfilling cannot message anyone, by construction
 * and not by care.
 *
 * On old failures: a case detected months ago is already past its deadline, so
 * the gate aborts every rung. That is correct — nobody wants a recovery message
 * about a payment they abandoned in December — and it means a backfill is safe
 * to run against history even once execution is switched on.
 */

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv();

import { eq, sql } from 'drizzle-orm';

import { createClient } from '../src/db/client.js';
import { merchants } from '../src/db/schema/tenancy.js';
import { customers } from '../src/db/schema/customers.js';
import { caseActions, caseEvents, paymentAttempts, recoveryCases } from '../src/db/schema/cases.js';
import { messageLog } from '../src/db/schema/messaging.js';
import { createRazorpayClient } from '../src/adapters/razorpay/client.js';
import type { RazorpayPaymentEntity } from '../src/adapters/razorpay/types.js';
import { processEvent } from '../src/ingest/pipeline.js';
import { formatINR, type Paise } from '../src/core/money.js';

const flag = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? process.env[`npm_config_${n}`];
const has = (n: string) =>
  process.argv.includes(`--${n}`) || process.env[`npm_config_${n}`] === 'true';

/** Wrap a real payment entity in the webhook envelope the pipeline expects. */
function envelopeFor(entity: RazorpayPaymentEntity) {
  return {
    entity: 'event',
    event: 'payment.failed',
    contains: ['payment'],
    payload: { payment: { entity: entity as Record<string, unknown> } },
    created_at: typeof entity.created_at === 'number' ? entity.created_at : undefined,
  };
}

async function main(): Promise<void> {
  const account = (flag('account') ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const days = Number(flag('days') ?? 180);

  if (!account) {
    console.error(
      '\n  --account is required. It names the env prefix:\n\n' +
        '    npm run backfill -- --account=TRADESMETRIX\n\n' +
        '  reads TRADESMETRIX_RAZORPAY_API_KEY and TRADESMETRIX_RAZORPAY_API_SECRET\n',
    );
    process.exit(1);
  }

  const keyId = process.env[`${account}_RAZORPAY_API_KEY`];
  const keySecret = process.env[`${account}_RAZORPAY_API_SECRET`];

  if (!keyId || !keySecret) {
    console.error(`\n  ${account}_RAZORPAY_API_KEY / _API_SECRET not set in .env.local\n`);
    process.exit(1);
  }

  const slug = `rzp-${account.toLowerCase()}`;
  const live = keyId.startsWith('rzp_live_');
  const { db, sql: raw } = createClient({ max: 4 });

  try {
    if (has('reset')) {
      const [m] = await db.select().from(merchants).where(eq(merchants.slug, slug)).limit(1);
      if (m) {
        await db.delete(messageLog).where(eq(messageLog.merchantId, m.id));
        await db.delete(caseActions).where(eq(caseActions.merchantId, m.id));
        await db.delete(caseEvents).where(eq(caseEvents.merchantId, m.id));
        await db.delete(paymentAttempts).where(eq(paymentAttempts.merchantId, m.id));
        await db.delete(recoveryCases).where(eq(recoveryCases.merchantId, m.id));
        await db.delete(customers).where(eq(customers.merchantId, m.id));
        await db.delete(merchants).where(eq(merchants.id, m.id));
        console.log(`\n  Removed ${slug}.\n`);
      } else {
        console.log(`\n  ${slug} not found.\n`);
      }
      return;
    }

    console.log(`\n  Backfill · ${account} · ${live ? 'LIVE' : 'test'} mode · last ${days} days`);
    console.log(`  ${keyId.slice(0, 16)}…`);
    console.log('  Read-only. Nothing is created in Razorpay and nothing is sent.\n');

    let [merchant] = await db.select().from(merchants).where(eq(merchants.slug, slug)).limit(1);
    if (!merchant) {
      const [created] = await db
        .insert(merchants)
        .values({
          name: account.charAt(0) + account.slice(1).toLowerCase(),
          slug,
          // Safe defaults, stated rather than assumed. A real account must not
          // start messaging because someone ran a backfill.
          executionEnabled: false,
        })
        .returning();
      merchant = created!;
      console.log(`  Created merchant '${merchant.name}' (execution disabled, dry run on)`);
    }

    const client = createRazorpayClient({ keyId, keySecret });
    const from = Math.floor((Date.now() - days * 86_400_000) / 1000);

    // Razorpay pages by `skip`. 100 is the maximum per request.
    const all: RazorpayPaymentEntity[] = [];
    for (let skip = 0; skip < 1000; skip += 100) {
      const page = await client.get<{ items?: RazorpayPaymentEntity[] }>('/payments', {
        count: 100,
        skip,
        from,
      });
      const items = page.items ?? [];
      all.push(...items);
      if (items.length < 100) break;
    }

    const failures = all.filter((p) => p.status === 'failed');
    console.log(`  Fetched ${all.length} payment(s); ${failures.length} failed.\n`);

    if (failures.length === 0) {
      console.log('  Nothing to ingest.\n');
      return;
    }

    let created = 0;
    let duplicate = 0;
    let aborted = 0;

    for (const payment of failures) {
      const at = typeof payment.created_at === 'number' ? new Date(payment.created_at * 1000) : new Date();

      const result = await processEvent(
        {
          db,
          merchantId: merchant.id,
          // The time the payment ACTUALLY failed. Diagnosis reads attempt
          // history and downtime relative to this, and the deadline is measured
          // from it — a months-old failure must land already expired, not fresh.
          now: at,
          holdoutBasisPoints: merchant.holdoutBasisPoints,
          holdoutEnabled: merchant.holdoutEnabled,
        },
        envelopeFor(payment),
      );

      if (!result.caseId) continue;

      // The pipeline stamps now() on insert; only a backfill needs history.
      const iso = at.toISOString();
      await db.execute(
        sql`update recovery_cases set created_at = ${iso}::timestamptz, updated_at = ${iso}::timestamptz where id = ${result.caseId}::uuid`,
      );
      await db.execute(
        sql`update case_events set occurred_at = ${iso}::timestamptz where case_id = ${result.caseId}::uuid`,
      );

      if (result.outcome === 'aborted') aborted++;
      else if (result.detail?.created === false) duplicate++;
      else created++;

      const amount = typeof payment.amount === 'number' ? payment.amount : 0;
      console.log(
        `  ${iso.slice(0, 10)}  ${String(payment.method ?? '?').padEnd(11)} ` +
          `${String(payment.error_reason ?? '—').padEnd(26)} ` +
          `${formatINR(amount as Paise, { compact: true }).padStart(11)}  ` +
          `${String(result.detail?.causeClass ?? '—').padEnd(17)} ${result.outcome}`,
      );
    }

    // Anything past its deadline should be closed, exactly as the sweep would.
    const expired = await db.execute(sql`
      update recovery_cases
         set state = 'lost', resolved_at = now(), updated_at = now()
       where merchant_id = ${merchant.id}
         and state in ('detected','diagnosed','executing','paused')
         and deadline_at < now()
      returning id
    `);
    const expiredCount = Array.isArray(expired)
      ? expired.length
      : ((expired as { rows?: unknown[] }).rows?.length ?? 0);

    const [summary] = await db
      .select({
        total: sql<number>`count(*)::int`,
        open: sql<number>`count(*) filter (where state in ('detected','diagnosed','executing','paused'))::int`,
        atRisk: sql<string>`coalesce(sum(case when state in ('detected','diagnosed','executing','paused') then amount_at_risk_paise else 0 end),0)::text`,
      })
      .from(recoveryCases)
      .where(eq(recoveryCases.merchantId, merchant.id));

    console.log(`\n  ${created} new · ${duplicate} already known · ${aborted} closed on arrival`);
    console.log(`  ${expiredCount} written off (past deadline — correct for old failures)`);
    console.log(
      `  ${summary?.open ?? 0} still open · ${formatINR(Number(summary?.atRisk ?? 0) as Paise, { compact: true })} at risk`,
    );
    console.log(`\n  npm run dev  →  http://localhost:3000\n`);
  } finally {
    await raw.end({ timeout: 5 });
  }
}

void main();
