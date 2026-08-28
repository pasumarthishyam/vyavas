/**
 * Fact gathering.
 *
 * The split this file exists to enforce: **the workflow gathers, core decides.**
 *
 * Everything here does I/O and nothing here makes a judgement. It reads the
 * order from Razorpay, counts recent messages, checks consent, and hands a flat
 * `PreconditionFacts` to `evaluatePreconditions`, which is pure and fully
 * testable without any of this.
 *
 * Keeping them apart is what makes "would we have messaged this person at 11pm
 * on a Sunday during an ICICI outage" a unit test rather than an experiment.
 */

import { and, count, eq, gt, isNull, sql } from 'drizzle-orm';

import type { Channel } from '../core/actions/types.js';
import type { PreconditionFacts } from '../core/guards/preconditions.js';
import { DEFAULT_QUIET_HOURS } from '../core/guards/quiet-hours.js';

import type { Database } from '../db/client.js';
import { customers } from '../db/schema/customers.js';
import { messageLog } from '../db/schema/messaging.js';
import { merchants } from '../db/schema/tenancy.js';
import { paymentAttempts, recoveryCases } from '../db/schema/cases.js';
import { isOrderPaid } from '../adapters/razorpay/resources.js';
import type { RazorpayClient } from '../adapters/razorpay/client.js';

export interface GatherOptions {
  db: Database;
  caseId: string;
  now: Date;
  /**
   * Omitted in dry-run and in tests, where we deliberately do not want to hit
   * Razorpay. Local state is then used, and that is stated in the audit trail
   * rather than quietly assumed.
   */
  razorpay?: RazorpayClient;
}

export interface GatheredFacts {
  facts: PreconditionFacts;
  /** Present so the executor can decide, and so the ledger can record, the source. */
  orderPaidCheckedRemotely: boolean;
  merchantName: string;
  dryRun: boolean;

  /** What composition and the send path need. Gathered once, here. */
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  customerLocale: string | null;

  amountPaise: number;
  rzpOrderId: string | null;
  rzpPaymentLinkId: string | null;
  /** Set once the ladder has created a link; composition refuses to send without one. */
  paymentLinkUrl: string | null;
}

export async function gatherFacts(opts: GatherOptions): Promise<GatheredFacts | null> {
  const { db, caseId, now } = opts;

  const rows = await db
    .select({ c: recoveryCases, m: merchants, cust: customers })
    .from(recoveryCases)
    .innerJoin(merchants, eq(merchants.id, recoveryCases.merchantId))
    .leftJoin(customers, eq(customers.id, recoveryCases.customerId))
    .where(eq(recoveryCases.id, caseId))
    .limit(1);

  const row = rows.at(0);
  if (!row) return null;

  const { c, m, cust } = row;

  // ── order state ──
  //
  // Ask Razorpay when we can. A case sleeps for hours and the customer may have
  // paid through an entirely different channel in that window; local state
  // would happily say otherwise.
  let orderPaid = c.state === 'recovered';
  let checkedRemotely = false;

  if (opts.razorpay && c.rzpOrderId) {
    const check = await isOrderPaid(opts.razorpay, c.rzpOrderId);
    orderPaid = check.paid;
    checkedRemotely = true;
  }

  // ── consent and deliverability ──
  // A recovery message is UTILITY-category: it is about a payment this person
  // just attempted with this merchant. The lawful basis is that transaction,
  // not a marketing opt-in — no Indian checkout collects one, so requiring it
  // would make every recovery message unsendable.
  //
  // An explicit opt-in still counts, and a global opt-out still overrides
  // everything (the gate checks that separately and aborts).
  const eligibleChannels: Channel[] = [];
  if (cust) {
    const basis = cust.transactionalBasisAt != null;
    const phoneOk = Boolean(cust.phone) && !cust.phoneUndeliverableAt;
    const emailOk = Boolean(cust.email) && !cust.emailUndeliverableAt;

    if (phoneOk && (basis || cust.whatsappOptIn)) eligibleChannels.push('whatsapp');
    if (phoneOk && (basis || cust.smsOptIn)) eligibleChannels.push('sms');
    if (emailOk && (basis || cust.emailOptIn)) eligibleChannels.push('email');
  }

  // ── the frequency window ──
  //
  // Across every case for this person, and excluding suppressed rows: a holdout
  // record must not consume a real customer's budget.
  let recentMessageCount = 0;
  if (c.customerId) {
    const [n] = await db
      .select({ n: count() })
      .from(messageLog)
      .where(
        and(
          eq(messageLog.customerId, c.customerId),
          isNull(messageLog.suppressedReason),
          gt(messageLog.sentAt, sql`now() - interval '24 hours'`),
        ),
      );
    recentMessageCount = Number(n?.n ?? 0);
  }

  // ── the live-attempt lock ──
  let lastAttemptAt: Date | null = null;
  if (c.rzpOrderId) {
    const [attempt] = await db
      .select({ at: paymentAttempts.attemptedAt })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.merchantId, c.merchantId),
          eq(paymentAttempts.rzpOrderId, c.rzpOrderId),
        ),
      )
      .orderBy(sql`${paymentAttempts.attemptedAt} desc`)
      .limit(1);
    lastAttemptAt = attempt?.at ?? null;
  }

  // ── today's budget ──
  const [sentToday] = await db
    .select({ n: count() })
    .from(messageLog)
    .where(
      and(
        eq(messageLog.merchantId, c.merchantId),
        isNull(messageLog.suppressedReason),
        gt(messageLog.sentAt, sql`date_trunc('day', now())`),
      ),
    );

  const facts: PreconditionFacts = {
    now,
    orderPaid,
    deadlinePassed: c.deadlineAt != null && now.getTime() >= c.deadlineAt.getTime(),
    customerOptedOut: cust?.optedOutAt != null,
    eligibleChannels,
    lastAttemptAt,
    liveAttemptWindowMinutes: m.liveAttemptLockMinutes,
    recentMessageCount,
    frequencyCap: m.frequencyCapPerDay,
    timeZone: m.timezone,
    quietHours: { start: m.quietHoursStart, end: m.quietHoursEnd },
    merchantBudgetRemaining: m.dailyMessageBudget - Number(sentToday?.n ?? 0),
    mandateActive: c.attended ? null : c.mandateId != null,
    executionEnabled: m.executionEnabled,
  };

  return {
    facts,
    orderPaidCheckedRemotely: checkedRemotely,
    merchantName: m.name,

    customerId: c.customerId,
    customerName: cust?.name ?? null,
    customerPhone: cust?.phone ?? null,
    customerEmail: cust?.email ?? null,
    customerLocale: cust?.locale ?? null,

    amountPaise: Number(c.amountAtRiskPaise),
    rzpOrderId: c.rzpOrderId,
    rzpPaymentLinkId: c.rzpPaymentLinkId,
    paymentLinkUrl: c.rzpPaymentLinkUrl,
    // Dry-run plans everything and sends nothing. Distinct from the kill switch:
    // execution_enabled=false stops the ladder entirely, dry_run lets it run and
    // records what it would have done.
    dryRun: m.dryRun,
  };
}

export { DEFAULT_QUIET_HOURS };
