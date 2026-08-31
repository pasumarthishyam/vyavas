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
import type { CauseClass } from '../core/taxonomy/cause-class.js';
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

  /**
   * The diagnosis tuple, carried through for the rungs that reason about the
   * case rather than the customer.
   *
   * `merchant_alert` needs it to build the cluster key — an alert is about "every
   * case failing this way on this bank and method", which is not derivable from
   * anything else already on this object. Free to carry: the row is selected in
   * full above either way.
   */
  causeClass: CauseClass | null;
  errorReason: string | null;
  bank: string | null;
  method: string;
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
  //
  // The oldest message still in the window comes back from the SAME query as
  // the count, because the two must describe the same instant. Read separately
  // they can disagree across a window boundary, and the gate would then sleep
  // until a slot that had already been taken.
  let recentMessageCount = 0;
  let oldestMessageInWindowAt: Date | null = null;
  if (c.customerId) {
    const [n] = await db
      .select({ n: count(), oldest: sql<Date | null>`min(${messageLog.sentAt})` })
      .from(messageLog)
      .where(
        and(
          eq(messageLog.customerId, c.customerId),
          isNull(messageLog.suppressedReason),
          gt(messageLog.sentAt, sql`now() - interval '24 hours'`),
        ),
      );
    recentMessageCount = Number(n?.n ?? 0);
    oldestMessageInWindowAt = n?.oldest ? new Date(n.oldest) : null;
  }

  // ── the live-attempt lock ──
  // EXCLUDES the attempt that opened this case.
  //
  // The lock means "they are already retrying, do not interrupt". The payment
  // that just failed is not them retrying — it is the event that summoned us,
  // and it is by definition seconds old. Counting it made every `0m` rung defer
  // by the lock window plus a minute, so `customer_input`, the one class whose
  // floor is deliberately zero, actually opened at four minutes. The comment in
  // customer-input.yaml says "they are looking at the error right now"; this is
  // what made that true.
  //
  // A genuine second attempt still trips the lock, which is the behaviour worth
  // keeping.
  let lastAttemptAt: Date | null = null;
  if (c.rzpOrderId) {
    const [attempt] = await db
      .select({ at: paymentAttempts.attemptedAt })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.merchantId, c.merchantId),
          eq(paymentAttempts.rzpOrderId, c.rzpOrderId),
          c.rzpPaymentId
            ? sql`${paymentAttempts.rzpPaymentId} <> ${c.rzpPaymentId}`
            : sql`true`,
        ),
      )
      .orderBy(sql`${paymentAttempts.attemptedAt} desc`)
      .limit(1);
    lastAttemptAt = attempt?.at ?? null;
  }

  // ── the cool-off gap ──
  //
  // The most recent REAL touch to this person, across every case. Suppressed
  // rows are excluded for the same reason as the cap: a holdout record must not
  // silence a treatment customer.
  //
  // Also counts the real touches ON THIS CASE, which is what decides whether a
  // rung is the first one. Read from the ledger rather than from the case's
  // `messagesSent` counter: a denormalised counter is only as good as every
  // code path that remembers to bump it, one of them did not, and the failure
  // mode is a case that claims to be a first touch forever — which would hand
  // the quiet-hours exemption to every rung it ever runs.
  let minutesSinceLastTouch: number | null = null;
  const [touchesOnCase] = await db
    .select({ n: count() })
    .from(messageLog)
    .where(and(eq(messageLog.caseId, caseId), isNull(messageLog.suppressedReason)));

  if (c.customerId) {
    const [last] = await db
      .select({ at: messageLog.sentAt })
      .from(messageLog)
      .where(and(eq(messageLog.customerId, c.customerId), isNull(messageLog.suppressedReason)))
      .orderBy(sql`${messageLog.sentAt} desc`)
      .limit(1);
    if (last?.at) {
      minutesSinceLastTouch = Math.floor((now.getTime() - last.at.getTime()) / 60_000);
    }
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
    oldestMessageInWindowAt,
    minutesSinceLastTouch,
    minGapMinutes: m.minGapMinutes,
    // Nobody has heard from us about this case yet.
    isFirstTouch: Number(touchesOnCase?.n ?? 0) === 0,
    minutesSinceFailure: Math.floor((now.getTime() - c.createdAt.getTime()) / 60_000),
    liveCustomerWindowMinutes: m.liveCustomerWindowMinutes,
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

    causeClass: c.causeClass,
    errorReason: c.errorReason,
    bank: c.bank,
    method: c.method,
    // Dry-run plans everything and sends nothing. Distinct from the kill switch:
    // execution_enabled=false stops the ladder entirely, dry_run lets it run and
    // records what it would have done.
    dryRun: m.dryRun,
  };
}

export { DEFAULT_QUIET_HOURS };
