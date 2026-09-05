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
import { effectiveDials } from '../core/limits.js';

import type { Database } from '../db/client.js';
import { customers } from '../db/schema/customers.js';
import { messageLog } from '../db/schema/messaging.js';
import { merchants } from '../db/schema/tenancy.js';
import { paymentAttempts, recoveryCases } from '../db/schema/cases.js';
import { isOrderPaid, isPaymentLinkPaid } from '../adapters/razorpay/resources.js';
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
  /**
   * What Razorpay says has actually arrived, when it says anything at all.
   *
   * Null unless a remote check came back paid. The ladder writes this to
   * `recovered_amount_paise` when it closes a case the gate found already paid,
   * so a recovery the webhook missed still carries a real figure instead of
   * falling back to the amount at risk. On a discounted link the two differ.
   */
  paidAmountPaise: number | null;
  /**
   * Razorpay actually said so.
   *
   * False when the gate is stopping the ladder on the assumption that the order
   * is paid because the API could not be reached. The ladder must stop either
   * way, but only a confirmed payment may be written to the ledger as one.
   */
  paidConfirmed: boolean;

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
  let paymentLinkPaid = false;
  let paidAmountPaise: number | null = null;
  let paidConfirmed = false;
  let checkedRemotely = false;

  if (opts.razorpay && c.rzpOrderId) {
    const check = await isOrderPaid(opts.razorpay, c.rzpOrderId);
    orderPaid = check.paid;
    // `confirmed` matters more than `paid` here. `isOrderPaid` answers "paid"
    // when Razorpay is unreachable so the ladder stays silent — right for
    // deciding whether to send, and disastrous for deciding whether to book a
    // recovery, which would mint revenue out of every API blip.
    paidConfirmed = check.paid && check.confirmed;
    if (paidConfirmed && check.amountPaidPaise > 0) paidAmountPaise = check.amountPaidPaise;
    checkedRemotely = true;
  }

  // ── and the recovery link, which is a DIFFERENT order ──
  //
  // A Razorpay payment link creates its own order when paid, so a customer who
  // paid on the link we sent leaves the original order at `created` and the
  // check above answers "no" forever. Without this the ladder kept messaging
  // people who had already paid, and the case was written off as lost.
  //
  // Skipped when the order already reads paid: the answer cannot change the
  // outcome, and this is a second network round trip on the hot path.
  if (opts.razorpay && c.rzpPaymentLinkId && !orderPaid) {
    const link = await isPaymentLinkPaid(opts.razorpay, c.rzpPaymentLinkId);
    paymentLinkPaid = link.paid;
    // No `confirmed` flag needed: this one fails closed to `paid: false`, so a
    // true here is always a real answer from Razorpay.
    if (link.paid) {
      paidConfirmed = true;
      if (link.amountPaidPaise > 0) paidAmountPaise = link.amountPaidPaise;
    }
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
  //
  // Only the channels there is actually a client for — see SENDABLE_CHANNELS.
  // SMS used to be listed here, which made `channel_deliverable` pass on a
  // customer we could reach by no other means: the gate saw a non-empty
  // eligible list, let the rung through, and `send.ts` then answered
  // `no_channel`. A case with a phone number and no email looked contactable
  // and never was.
  const eligibleChannels: Channel[] = [];
  if (cust) {
    const basis = cust.transactionalBasisAt != null;
    const phoneOk = Boolean(cust.phone) && !cust.phoneUndeliverableAt;
    const emailOk = Boolean(cust.email) && !cust.emailUndeliverableAt;

    if (phoneOk && (basis || cust.whatsappOptIn)) eligibleChannels.push('whatsapp');
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

  /*
   * ── today's budget ──
   *
   * "Today" in the MERCHANT's timezone, not the database server's.
   *
   * This read `date_trunc('day', now())`, which is UTC, so an Indian merchant's
   * daily budget reset at 05:30 IST. Everything else in this file is careful
   * about the merchant's local time — quiet hours are computed in their zone —
   * and a budget that resets in the middle of the night while the quiet-hours
   * window is still open is the one boundary nobody would ever notice being
   * wrong, right up until a merchant asks why they burned two days of budget on
   * one morning.
   */
  const [sentToday] = await db
    .select({ n: count() })
    .from(messageLog)
    .where(
      and(
        eq(messageLog.merchantId, c.merchantId),
        isNull(messageLog.suppressedReason),
        gt(
          messageLog.sentAt,
          sql`date_trunc('day', now() at time zone ${m.timezone}) at time zone ${m.timezone}`,
        ),
      ),
    );

  // Every dial the gate is about to read, clamped into the range the code
  // permits. A stored value outside it (the frequency cap sat at 1000 through
  // testing) is brought back to the edge here rather than trusted — see
  // `core/limits.ts` for why this is a read-time guard and not a write-time one.
  const dials = effectiveDials(m);

  const facts: PreconditionFacts = {
    now,
    orderPaid,
    paymentLinkPaid,
    deadlinePassed: c.deadlineAt != null && now.getTime() >= c.deadlineAt.getTime(),
    customerOptedOut: cust?.optedOutAt != null,
    eligibleChannels,
    lastAttemptAt,
    liveAttemptWindowMinutes: dials.liveAttemptLockMinutes,
    recentMessageCount,
    frequencyCap: dials.frequencyCapPerDay,
    oldestMessageInWindowAt,
    minutesSinceLastTouch,
    minGapMinutes: dials.minGapMinutes,
    // Nobody has heard from us about this case yet.
    isFirstTouch: Number(touchesOnCase?.n ?? 0) === 0,
    minutesSinceFailure: Math.floor((now.getTime() - c.createdAt.getTime()) / 60_000),
    liveCustomerWindowMinutes: dials.liveCustomerWindowMinutes,
    timeZone: m.timezone,
    quietHours: { start: m.quietHoursStart, end: m.quietHoursEnd },
    merchantBudgetRemaining: dials.dailyMessageBudget - Number(sentToday?.n ?? 0),
    mandateActive: c.attended ? null : c.mandateId != null,
    executionEnabled: m.executionEnabled,
  };

  return {
    facts,
    orderPaidCheckedRemotely: checkedRemotely,
    paidAmountPaise,
    paidConfirmed,
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
  };
}

export { DEFAULT_QUIET_HOURS };
