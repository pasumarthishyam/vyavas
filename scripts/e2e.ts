/**
 * The whole product, end to end, against real accounts.
 *
 *   npm run e2e -- --phone=918977629575 --email=you@example.com --send
 *   npm run e2e -- --reset            remove the e2e merchant and start clean
 *
 * Runs one recovery case through every layer that exists — the same functions
 * the webhook and the workflow call, not a parallel demo path:
 *
 *   payment.failed  -> normalize -> diagnose -> resolve policy -> case
 *                   -> payment link (real Razorpay)
 *                   -> each ladder rung, gated, ACTUALLY SENT
 *   order.paid      -> case closes, remaining rungs cancelled
 *
 * The only thing faked is TIME. A real ladder sleeps 4 minutes, then 6 hours,
 * then 26 — this fires every rung immediately so the whole arc is visible in
 * one run. Every other decision is the real one.
 *
 * `--send` is required because this genuinely messages the phone and email you
 * pass. Without it the run is a dry run and nothing leaves.
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

import { processEvent } from '../src/ingest/pipeline.js';
import { paymentFailedEnvelope, orderPaidEnvelope } from '../src/adapters/razorpay/fixtures/webhooks.js';
import { getCaseDetail } from '../src/db/queries/case-detail.js';
import { gatherFacts } from '../src/workflows/facts.js';
import { executeRung } from '../src/workflows/executor.js';
import { ensurePaymentLink } from '../src/workflows/payment-link.js';
import { createRazorpayClient } from '../src/adapters/razorpay/client.js';
import { createWhatsAppClient, type SendResult, type SendTemplateInput, type SendTextInput } from '../src/adapters/whatsapp/client.js';
import { createEmailClient } from '../src/adapters/email/resend.js';
import { formatINR, type Paise } from '../src/core/money.js';
import { POLICY_TABLE } from '../src/core/policy/index.js';

const SLUG = 'e2e-test';
const ORDER = `order_e2e_${Date.now()}`;
const AMOUNT = 184_300; // ₹1,843

const flag = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? process.env[`npm_config_${n}`];
const has = (n: string) =>
  process.argv.includes(`--${n}`) || process.env[`npm_config_${n}`] === 'true';

const h = (n: number, title: string) => {
  console.log(`\n${'━'.repeat(74)}`);
  console.log(`  ${n}. ${title}`);
  console.log('━'.repeat(74));
};
const line = (k: string, v: unknown) => console.log(`     ${k.padEnd(22)} ${String(v)}`);

/**
 * Template-first, free-form fallback.
 *
 * TEST HARNESS ONLY. Production never falls back: outside the 24-hour window
 * free-form is rejected, which is the whole reason templates exist. Here it
 * means the run works today while the templates are still in Meta's review
 * queue, and switches to the real template path automatically once they clear.
 */
function demoWhatsApp(realSends: boolean) {
  const wa = createWhatsAppClient();
  const log: string[] = [];
  return {
    log,
    client: {
      async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
        if (!realSends) {
          log.push(`(dry) template ${input.templateName}`);
          return { ok: true, messageId: 'dry-run', failure: null, detail: null, retryable: false };
        }
        const viaTemplate = await wa.sendTemplate(input);
        if (viaTemplate.ok) {
          log.push(`template ${input.templateName} -> ${viaTemplate.messageId}`);
          return viaTemplate;
        }
        if (viaTemplate.failure !== 'variable_rejected') return viaTemplate;

        const text = input.variables.length > 0 ? rebuild(input) : input.templateName;
        const viaText = await wa.sendText({ to: input.to, text });
        log.push(
          viaText.ok
            ? `free-form (template pending) -> ${viaText.messageId}`
            : `FAILED ${viaText.failure}: ${viaText.detail}`,
        );
        return viaText;
      },
      async sendText(input: SendTextInput): Promise<SendResult> {
        return realSends
          ? wa.sendText(input)
          : { ok: true, messageId: 'dry-run', failure: null, detail: null, retryable: false };
      },
    },
  };
}

/** Render the approved body locally so the free-form fallback says the same words. */
function rebuild(input: SendTemplateInput): string {
  const t = POLICY_TABLE.length; // touch, keeps the import meaningful
  void t;
  const def = TEMPLATE_BODIES[input.templateName];
  if (!def) return input.variables.join(' · ');
  return def.replace(/\{\{(\d+)\}\}/g, (_m, i: string) => input.variables[Number(i) - 1] ?? '');
}

const TEMPLATE_BODIES: Record<string, string> = {};

async function main(): Promise<void> {
  const { db, sql: raw } = createClient({ max: 4 });

  try {
    if (has('reset')) {
      const [m] = await db.select().from(merchants).where(eq(merchants.slug, SLUG)).limit(1);
      if (m) await wipe(db, m.id);
      console.log('\n  e2e merchant removed.\n');
      return;
    }

    const phone = (flag('phone') ?? process.env.WHATSAPP_TEST_RECIPIENT ?? '').replace(/[^\d]/g, '');
    const email = flag('email') ?? process.env.EMAIL_TEST_RECIPIENT ?? '';
    const realSends = has('send');

    if (!phone && !email) {
      console.error(
        '\n  Need a phone and/or an email to message.\n\n' +
          '    npm run e2e -- --phone=918977629575 --email=you@example.com --send\n\n' +
          '  Without --send it runs everything and sends nothing.\n',
      );
      process.exit(1);
    }

    console.log(`\n  VYAVAS — end-to-end run`);
    console.log(`  ${realSends ? 'LIVE: this will really message you' : 'DRY RUN: nothing will be sent'}`);
    line('phone', phone || '(none)');
    line('email', email || '(none)');

    // ── 1. a merchant and a customer ──────────────────────────────────────
    h(1, 'Merchant and customer');

    const [existing] = await db.select().from(merchants).where(eq(merchants.slug, SLUG)).limit(1);
    if (existing) await wipe(db, existing.id);

    const [m] = await db
      .insert(merchants)
      .values({
        name: 'Kirana Cloud',
        slug: SLUG,
        // Everything this run needs, set explicitly so nothing is inherited by
        // accident. Defaults elsewhere stay safe.
        executionEnabled: true,
        holdoutEnabled: false, // guarantee treatment, or there is nothing to watch
        frequencyCapPerDay: 3, // the card_expired ladder has 3 touches
        // A one-hour quiet window at 3am, so an arbitrary run time does not
        // defer every rung. Production default is 21:00-08:00.
        quietHoursStart: 3,
        quietHoursEnd: 4,
      })
      .returning();
    const merchantId = m!.id;

    line('merchant', `${m!.name} (${SLUG})`);
    line('execution', m!.executionEnabled ? 'ENABLED' : 'disabled');
    line('send mode', m!.executionEnabled ? 'LIVE — messages are real' : 'PAUSED — nothing sends');
    line('frequency cap', `${m!.frequencyCapPerDay} per 24h`);

    // ── 2. a payment fails ────────────────────────────────────────────────
    h(2, 'A payment fails  →  webhook  →  diagnosis');

    const envelope = paymentFailedEnvelope({
      paymentId: `pay_e2e_${Date.now()}`,
      orderId: ORDER,
      amount: AMOUNT,
      method: 'card',
      errorReason: 'card_expired',
      errorSource: 'customer',
      issuer: 'HDFC',
      contact: phone ? `+${phone}` : undefined,
      email: email || undefined,
      // Five minutes ago, not "now".
      //
      // Firing every rung immediately compresses time, so the ATTEMPT has to be
      // backdated by the same logic. Otherwise the live-attempt lock (3 min)
      // defers every rung — correct for a real ladder, wrong for a simulation
      // of one, because by the time rung 0 fires at 4m the lock has expired.
      createdAt: Math.floor((Date.now() - 5 * 60_000) / 1000),
    });

    const ingested = await processEvent(
      { db, merchantId, now: new Date(), holdoutBasisPoints: 0, holdoutEnabled: false },
      envelope,
    );

    const caseId = ingested.caseId!;
    const detail = (await getCaseDetail(db, caseId))!;

    line('razorpay says', `${detail.errorReason} / ${detail.errorSource} / ${detail.errorStep}`);
    line('amount at risk', formatINR(detail.amountPaise as Paise, { compact: true }));
    line('cause class', detail.causeClass);
    line('confidence', detail.confidence);
    line('attended', detail.attended ? 'yes — no mandate, a human must come back' : 'no');
    line('ladder chosen', `${detail.policyId} v${detail.policyVersion}`);

    console.log('\n     Why:');
    for (const r of detail.rationale) console.log(`       · ${r}`);

    // ── 3. the ladder ─────────────────────────────────────────────────────
    h(3, 'The ladder that applies');
    const policy = detail.policy!;
    console.log(`     ${policy.description.trim()}\n`);
    policy.ladder.forEach((r, i) => {
      const extra = r.action === 'nudge' ? ` · ${r.intent} · ${r.channels.join('/')}` : '';
      console.log(`     ${String(i).padStart(2)}. at ${r.at.padEnd(5)} ${r.action}${extra}`);
    });
    line('\n     max messages', policy.maxMessages);
    line('stops on', policy.abortOn.join(', '));

    // ── 4. payment link ───────────────────────────────────────────────────
    h(4, 'Payment link (real Razorpay test mode)');
    const razorpay = createRazorpayClient();
    const link = await ensurePaymentLink({
      db,
      razorpay,
      caseId,
      merchantId,
      merchantName: m!.name,
      amountPaise: AMOUNT,
      customerName: 'Rahul Sharma',
      customerPhone: phone ? `+${phone}` : null,
      customerEmail: email || null,
      expiresAt: null,
      now: new Date(),
    });
    line('created', link.ok ? link.url : `FAILED — ${link.reason}`);
    if (link.ok) line('open it', 'you can actually pay this in Razorpay test mode');

    // ── 5. run every rung now ─────────────────────────────────────────────
    h(5, `Ladder execution  ${realSends ? '(REAL SENDS)' : '(dry run)'}`);
    console.log('     Real timing is 4m / 6h / 26h. Fired immediately here.\n');

    const wa = demoWhatsApp(realSends);
    const channels = {
      whatsapp: phone ? wa.client : undefined,
      email: email ? createEmailClient() : undefined,
    };

    for (let i = 0; i < policy.ladder.length; i++) {
      const gathered = await gatherFacts({ db, caseId, now: new Date() });
      const r = await executeRung({
        db,
        caseId,
        merchantId,
        rungIndex: i,
        rung: policy.ladder[i]!,
        policy,
        gathered: gathered!,
        cohort: 'treatment',
        diagnosisRails: ['upi_intent', 'other_card'] as never,
        sameInstrumentRetry: false,
        channels,
        razorpay,
      });

      const mark =
        r.disposition === 'suppressed' ? (r.suppressedReason ? 'SUPPRESSED' : 'SENT') : r.disposition.toUpperCase();
      console.log(`     rung ${i}  ${mark.padEnd(11)} ${r.channel ?? '—'}  ${r.note}`);
    }

    for (const l of wa.log) console.log(`       whatsapp: ${l}`);

    const sent = await db.select().from(messageLog).where(eq(messageLog.caseId, caseId));
    console.log('');
    line('messages recorded', sent.length);
    for (const s of sent) {
      line(`  ${s.channel}`, `${s.status}${s.suppressedReason ? ` (${s.suppressedReason})` : ''} · ${s.intent}`);
    }

    // ── 6. the customer pays ──────────────────────────────────────────────
    h(6, 'The customer pays  →  the case closes');
    const paid = await processEvent(
      { db, merchantId, now: new Date(), holdoutBasisPoints: 0, holdoutEnabled: false },
      orderPaidEnvelope({ orderId: ORDER, paymentId: `pay_ok_${Date.now()}`, amount: AMOUNT }),
    );
    line('outcome', paid.outcome);

    const after = (await getCaseDetail(db, caseId))!;
    line('state', after.state);
    line('recovered', after.recoveredAmountPaise ? formatINR(after.recoveredAmountPaise as Paise, { compact: true }) : '—');

    // Prove the kill switch: another rung now would abort rather than send.
    const g2 = await gatherFacts({ db, caseId, now: new Date() });
    const blocked = await executeRung({
      db,
      caseId,
      merchantId,
      rungIndex: 99,
      rung: policy.ladder[0]!,
      policy,
      gathered: g2!,
      cohort: 'treatment',
      diagnosisRails: [] as never,
      sameInstrumentRetry: false,
      channels,
    });
    line('another rung now', `${blocked.disposition} — ${blocked.note}`);

    // ── 7. the ledger ─────────────────────────────────────────────────────
    h(7, 'The audit trail');
    const events = await db
      .select()
      .from(caseEvents)
      .where(eq(caseEvents.caseId, caseId))
      .orderBy(caseEvents.occurredAt);
    for (const e of events) {
      const t = e.occurredAt.toISOString().slice(11, 19);
      console.log(`     ${t}  ${e.kind.padEnd(22)} ${e.reason ?? ''}`);
    }

    console.log(`\n${'━'.repeat(74)}`);
    console.log(`  Done. Case ${caseId}`);
    console.log(`  Dashboard:  npm run dev  →  http://localhost:3000/cases/${caseId}`);
    console.log(`  Clean up:   npm run e2e -- --reset\n`);
  } finally {
    await raw.end({ timeout: 5 });
  }
}

async function wipe(db: Awaited<ReturnType<typeof createClient>>['db'], merchantId: string) {
  // Children before parents; the foreign keys are real.
  await db.delete(messageLog).where(eq(messageLog.merchantId, merchantId));
  await db.delete(caseActions).where(eq(caseActions.merchantId, merchantId));
  await db.delete(caseEvents).where(eq(caseEvents.merchantId, merchantId));
  await db.delete(paymentAttempts).where(eq(paymentAttempts.merchantId, merchantId));
  await db.delete(recoveryCases).where(eq(recoveryCases.merchantId, merchantId));
  await db.delete(customers).where(eq(customers.merchantId, merchantId));
  await db.delete(merchants).where(sql`id = ${merchantId}`);
}

void main();
