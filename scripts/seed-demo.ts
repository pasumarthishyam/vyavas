/**
 * Load a realistic demo account.
 *
 *   npm run seed:demo          add demo data
 *   npm run seed:demo -- --reset   wipe this merchant first
 *
 * Everything here goes through the REAL pipeline — `processEvent`, the same
 * function the webhook route calls. Nothing is hand-inserted.
 *
 * That matters for two reasons. The dashboard ends up showing data the system
 * genuinely produced, so what you see is what it would really do; and seeding
 * exercises normalize → diagnose → resolve → persist end to end against the
 * live database, which is a much better smoke test than any assertion.
 *
 * The distribution is India-shaped on purpose: UPI-dominant, insufficient funds
 * and bank downtime leading the failures, amounts skewed to small tickets with
 * a long tail. A demo with a flat distribution makes the dashboard look
 * plausible while teaching you nothing about how it reads under real data.
 */

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv();

import { eq, sql } from 'drizzle-orm';

import { createClient } from '../src/db/client.js';
import { merchants, razorpayConnections } from '../src/db/schema/tenancy.js';
import { customers } from '../src/db/schema/customers.js';
import { caseActions, caseEvents, paymentAttempts, recoveryCases } from '../src/db/schema/cases.js';
import { messageLog } from '../src/db/schema/messaging.js';
import { merchantAlerts, webhookEvents } from '../src/db/schema/ops.js';
import { processEvent } from '../src/ingest/pipeline.js';
import { paymentFailedEnvelope, orderPaidEnvelope } from '../src/adapters/razorpay/fixtures/webhooks.js';
import { transitionCase } from '../src/db/repos/cases.js';

const SLUG = 'demo-merchant';

/** Deterministic PRNG so the demo account is reproducible run to run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const rand = rng(20260827);

const pick = <T>(items: readonly [T, number][]): T => {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let r = rand() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r <= 0) return item;
  }
  return items[0]![0];
};

// India-shaped: UPI leads by a wide margin, cards second.
const METHODS: readonly [string, number][] = [
  ['upi', 46],
  ['card', 28],
  ['netbanking', 18],
  ['wallet', 5],
  ['emi', 3],
];

const BANKS: readonly [string, number][] = [
  ['HDFC', 22],
  ['ICIC', 18],
  ['UTIB', 14],
  ['SBIN', 16],
  ['KKBK', 10],
  ['YESB', 7],
  ['PUNB', 7],
  ['IDIB', 6],
];

/** Reason, source, and how often it shows up in Indian traffic. */
const FAILURES: readonly [[string, string], number][] = [
  [['insufficient_funds', 'bank'], 16],
  [['payment_cancelled', 'customer'], 14],
  [['bank_technical_error', 'bank'], 12],
  [['payment_timed_out', 'gateway'], 9],
  [['incorrect_otp', 'customer'], 8],
  [['authentication_failed', 'customer'], 7],
  [['card_expired', 'customer'], 6],
  [['card_not_enrolled', 'issuer'], 5],
  [['gateway_technical_error', 'gateway'], 5],
  [['payment_risk_check_failed', 'bank'], 4],
  [['transaction_limit_exceeded', 'bank'], 4],
  [['incorrect_cvv', 'customer'], 3],
  [['card_disabled_for_online_payments', 'issuer'], 3],
  [['invalid_vpa', 'bank'], 2],
  [['bank_not_enabled', 'business'], 2],
];

/** Small tickets dominate; a long tail carries most of the money. */
function amountPaise(): number {
  const r = rand();
  if (r < 0.55) return Math.round((300 + rand() * 1700) * 100);
  if (r < 0.85) return Math.round((2000 + rand() * 8000) * 100);
  if (r < 0.97) return Math.round((10000 + rand() * 30000) * 100);
  return Math.round((40000 + rand() * 160000) * 100);
}

const FIRST = ['Rahul', 'Priya', 'Arjun', 'Sneha', 'Vikram', 'Ananya', 'Karthik', 'Meera', 'Rohan', 'Divya', 'Aditya', 'Kavya', 'Sanjay', 'Nisha', 'Farhan', 'Ishita'];
const LAST = ['Sharma', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Gupta', 'Singh', 'Menon', 'Rao', 'Desai', 'Kulkarni', 'Bose'];

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const { db, sql: raw } = createClient({ max: 4 });

  try {
    let [merchant] = await db.select().from(merchants).where(eq(merchants.slug, SLUG)).limit(1);

    if (merchant && reset) {
      console.log('Resetting demo merchant…');
      const id = merchant.id;
      // Order matters: children before parents, since the FKs are real.
      await db.delete(messageLog).where(eq(messageLog.merchantId, id));
      await db.delete(caseActions).where(eq(caseActions.merchantId, id));
      await db.delete(caseEvents).where(eq(caseEvents.merchantId, id));
      await db.delete(paymentAttempts).where(eq(paymentAttempts.merchantId, id));
      await db.delete(recoveryCases).where(eq(recoveryCases.merchantId, id));
      await db.delete(customers).where(eq(customers.merchantId, id));
      await db.delete(merchantAlerts).where(eq(merchantAlerts.merchantId, id));
      await db.delete(webhookEvents).where(eq(webhookEvents.merchantId, id));
      await db.delete(razorpayConnections).where(eq(razorpayConnections.merchantId, id));
      await db.delete(merchants).where(eq(merchants.id, id));
      merchant = undefined as never;
    }

    if (!merchant) {
      const inserted = await db
        .insert(merchants)
        .values({
          name: 'Kirana Cloud',
          slug: SLUG,
          holdoutBasisPoints: 1000,
          holdoutEnabled: true,
          // Defaults stay safe even in a demo: nothing sends.
          executionEnabled: false,
        })
        .returning();
      merchant = inserted[0]!;
      console.log(`Created merchant ${merchant.name}`);
    }

    const merchantId = merchant.id;
    const now = new Date();
    const DAY = 86_400_000;

    // An open outage, so the downtime-gated path is visible on the dashboard.
    await db.execute(sql`
      insert into downtime_windows (id, method, bank, severity, status, started_at)
      values ('down_demo_icic', 'netbanking', 'ICIC', 'high', 'started', now() - interval '90 minutes')
      on conflict (id) do nothing
    `);

    const TOTAL = 320;
    console.log(`Generating ${TOTAL} failures through the real pipeline…`);

    const created: { id: string; at: Date; amount: number }[] = [];

    for (let i = 0; i < TOTAL; i++) {
      // Weight recent days more heavily — a merchant's traffic is not flat, and
      // a flat seed makes the trend line look synthetic.
      const daysAgo = Math.floor(Math.pow(rand(), 1.7) * 30);
      const at = new Date(now.getTime() - daysAgo * DAY - Math.floor(rand() * DAY));

      const method = pick(METHODS);
      const [reason, source] = pick(FAILURES);
      const bank = pick(BANKS);
      const amount = amountPaise();

      const person = `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`;
      const phone = `+9198${String(Math.floor(10_000_000 + rand() * 89_999_999))}`;

      const envelope = paymentFailedEnvelope({
        paymentId: `pay_demo${String(i).padStart(6, '0')}`,
        orderId: `order_demo${String(i).padStart(6, '0')}`,
        amount,
        method,
        errorReason: reason,
        errorSource: source,
        bank: method === 'netbanking' ? bank : undefined,
        issuer: method === 'card' ? bank : undefined,
        contact: phone,
        email: `${person.split(' ')[0]!.toLowerCase()}${i}@example.com`,
        createdAt: Math.floor(at.getTime() / 1000),
      });

      const result = await processEvent(
        { db, merchantId, now: at, holdoutBasisPoints: 1000, holdoutEnabled: true },
        envelope,
      );

      if (result.caseId) created.push({ id: result.caseId, at, amount });

      if ((i + 1) % 80 === 0) console.log(`  ${i + 1}/${TOTAL}`);
    }

    // Backdate so the trend spans the window. The pipeline stamps now() on
    // insert; only the demo needs history.
    console.log('Backdating…');
    for (const c of created) {
      // ISO string + explicit cast, not a raw Date: postgres.js cannot infer a
      // parameter type for a Date inside a template with prepare:false, and
      // fails with ERR_INVALID_ARG_TYPE rather than coercing it.
      const iso = c.at.toISOString();
      await db.execute(
        sql`update recovery_cases set created_at = ${iso}::timestamptz, updated_at = ${iso}::timestamptz where id = ${c.id}::uuid`,
      );
      await db.execute(
        sql`update case_events set occurred_at = ${iso}::timestamptz where case_id = ${c.id}::uuid`,
      );
    }

    // Resolve a realistic share: some paid, some ran out of runway.
    console.log('Resolving a share of cases…');
    let recovered = 0;
    let lost = 0;

    for (const c of created) {
      const age = (now.getTime() - c.at.getTime()) / DAY;
      if (age < 2) continue; // still live

      const roll = rand();
      if (roll < 0.34) {
        const paidAt = new Date(c.at.getTime() + rand() * 2 * DAY);
        await processEvent(
          { db, merchantId, now: paidAt, holdoutBasisPoints: 1000, holdoutEnabled: true },
          orderPaidEnvelope({
            orderId: `order_demo${created.indexOf(c).toString().padStart(6, '0')}`,
            paymentId: `pay_ok${created.indexOf(c)}`,
            amount: c.amount,
          }),
        );
        await db.execute(
          sql`update recovery_cases set resolved_at = ${paidAt.toISOString()}::timestamptz where id = ${c.id}::uuid and state = 'recovered'`,
        );
        recovered++;
      } else if (roll < 0.55) {
        const r = await transitionCase(db, c.id, 'lost', 'deadline_passed', { actor: 'demo' });
        if (r.ok) lost++;
      }
    }

    // A merchant-config breakage, so the alert surface is visible. Diagnostic
    // only — it states what broke and when, never what to switch off.
    const icicCases = created.length;
    await db
      .insert(merchantAlerts)
      .values({
        merchantId,
        severity: 'critical',
        signal: 'bank_not_enabled:ICIC:netbanking',
        title: 'ICICI netbanking is failing every attempt',
        detail:
          'Every ICICI netbanking payment has been declined with bank_not_enabled since 14:10 today. ' +
          'Your normal failure rate on this method is 2.1%. Affected customers are being offered UPI instead.',
        affectedCases: Math.max(3, Math.round(icicCases * 0.04)),
        amountAtRiskPaise: 18_43_00 * 4,
        baselineRateBps: 210,
        onsetAt: new Date(now.getTime() - 3 * 3600_000),
      })
      .onConflictDoNothing();

    const [summary] = await db
      .select({
        total: sql<number>`count(*)::int`,
        open: sql<number>`count(*) filter (where state in ('detected','diagnosed','executing','paused'))::int`,
        atRisk: sql<string>`coalesce(sum(case when state in ('detected','diagnosed','executing','paused') then amount_at_risk_paise else 0 end), 0)::text`,
      })
      .from(recoveryCases)
      .where(eq(recoveryCases.merchantId, merchantId));

    console.log('\nDone.');
    console.log(`  merchant   ${merchant.name} (${SLUG})`);
    console.log(`  cases      ${summary?.total ?? 0} total, ${summary?.open ?? 0} open`);
    console.log(`  recovered  ${recovered}`);
    console.log(`  lost       ${lost}`);
    console.log(`  at risk    ₹${(Number(summary?.atRisk ?? 0) / 100).toLocaleString('en-IN')}`);
    console.log('\n  npm run dev  →  http://localhost:3000');
  } finally {
    await raw.end({ timeout: 5 });
  }
}

void main();
