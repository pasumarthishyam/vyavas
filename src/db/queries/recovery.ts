/**
 * The recovery console's data.
 *
 * One question per function, answered in one query. The console shows live
 * state and polls, so anything here runs every couple of seconds — it stays
 * narrow deliberately.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { paiseFromColumn } from '../util.js';
import { caseEvents, recoveryCases } from '../schema/cases.js';
import { customers } from '../schema/customers.js';
import { merchants } from '../schema/tenancy.js';
import { messageLog } from '../schema/messaging.js';
import type { CaseState } from '../../core/case/types.js';

const LIVE: CaseState[] = ['detected', 'diagnosed', 'executing', 'paused'];

export interface RecoverableCase {
  id: string;
  amountPaise: number;
  causeClass: string | null;
  errorReason: string | null;
  method: string;
  bank: string | null;
  createdAt: Date;
  deadlineAt: Date | null;
  state: string;
  messagesSent: number;
  paymentLinkUrl: string | null;

  customerId: string | null;
  customerName: string | null;
  /** Masked. A screenshot of this page must not carry a full number. */
  phoneMasked: string | null;
  emailMasked: string | null;
  /** Unmasked, needed to decide whether a channel is even possible. */
  hasPhone: boolean;
  hasEmail: boolean;
  optedOut: boolean;
}

export async function getRecoverableCases(
  db: Database,
  merchantId: string,
): Promise<RecoverableCase[]> {
  const rows = await db
    .select({ c: recoveryCases, cust: customers })
    .from(recoveryCases)
    .leftJoin(customers, eq(customers.id, recoveryCases.customerId))
    .where(and(eq(recoveryCases.merchantId, merchantId), inArray(recoveryCases.state, LIVE)))
    .orderBy(desc(recoveryCases.amountAtRiskPaise))
    .limit(50);

  return rows.map(({ c, cust }) => ({
    id: c.id,
    amountPaise: paiseFromColumn(c.amountAtRiskPaise),
    causeClass: c.causeClass,
    errorReason: c.errorReason,
    method: c.method,
    bank: c.bank,
    createdAt: c.createdAt,
    deadlineAt: c.deadlineAt,
    state: c.state,
    messagesSent: c.messagesSent,
    paymentLinkUrl: c.rzpPaymentLinkUrl,
    customerId: c.customerId,
    customerName: cust?.name ?? null,
    phoneMasked: cust?.phone ? `${cust.phone.slice(0, 3)}•••••${cust.phone.slice(-4)}` : null,
    emailMasked: cust?.email ? maskEmail(cust.email) : null,
    hasPhone: Boolean(cust?.phone) && !cust?.phoneUndeliverableAt,
    hasEmail: Boolean(cust?.email) && !cust?.emailUndeliverableAt,
    optedOut: cust?.optedOutAt != null,
  }));
}

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return '—';
  return `${user.slice(0, 3)}•••@${domain}`;
}

/** A message that was actually attempted. */
export interface MessageActivity {
  kind: 'message';
  id: string;
  caseId: string | null;
  at: Date;
  channel: string;
  intent: string;
  status: string;
  suppressedReason: string | null;
  providerMessageId: string | null;
  error: string | null;
}

/** A decision the system made, whether or not it led to a message. */
export interface DecisionActivity {
  kind: 'decision';
  id: string;
  caseId: string | null;
  at: Date;
  /** `rung_deferred`, `diagnosed`, `state_changed`, `rung_abandoned`, … */
  event: string;
  actor: string;
  /** The gate's own words: why it deferred, aborted or moved on. */
  reason: string | null;
  /** When the system intends to try again, when it said so. */
  retryAt: Date | null;
  detail: string | null;
}

export type ActivityRow = MessageActivity | DecisionActivity;

/**
 * Which decisions are worth a line in the feed.
 *
 * Deliberately a list, not "everything". The feed answers one question — why
 * has this case not been paid yet — and a row that cannot contribute to that
 * answer makes the rows that can harder to find.
 */
const NOTABLE_EVENTS = [
  'diagnosed',
  'rung_fired',
  'rung_deferred',
  'rung_aborted',
  'rung_abandoned',
  'rung_uncomposable',
  'ladder_complete',
  'payment_link_created',
  'recovery_started',
  'state_changed',
];

/**
 * Recent activity, newest first: what was sent AND why it was or was not.
 *
 * This used to read `message_log` alone, and that one omission is why a working
 * system looked like a dead one. When the gate defers every rung, nothing is
 * ever written to `message_log`, so the console showed "Nothing sent yet" while
 * `case_events` held a precise, timestamped record of the reason — four
 * `rung_deferred` rows naming the frequency cap and the exact instant it would
 * clear. The data was always there; the feed simply never looked at it.
 *
 * Two queries rather than a UNION: the tables share no useful column shape, and
 * merging in SQL would mean casting both into a lowest common denominator that
 * loses the fields the UI actually renders.
 */
export async function getRecentActivity(
  db: Database,
  merchantId: string,
  limit = 25,
): Promise<ActivityRow[]> {
  const [messages, decisions] = await Promise.all([
    db
      .select()
      .from(messageLog)
      .where(eq(messageLog.merchantId, merchantId))
      .orderBy(desc(messageLog.sentAt))
      .limit(limit),
    db
      .select()
      .from(caseEvents)
      .where(
        and(eq(caseEvents.merchantId, merchantId), inArray(caseEvents.kind, NOTABLE_EVENTS)),
      )
      .orderBy(desc(caseEvents.occurredAt))
      .limit(limit),
  ]);

  const rows: ActivityRow[] = [
    ...messages.map(
      (r): MessageActivity => ({
        kind: 'message',
        id: r.id,
        caseId: r.caseId,
        at: r.sentAt,
        channel: r.channel,
        intent: r.intent,
        status: r.status,
        suppressedReason: r.suppressedReason,
        providerMessageId: r.providerMessageId,
        error: r.error,
      }),
    ),
    ...decisions.map((r): DecisionActivity => {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      const retryAt = typeof payload.retryAt === 'string' ? new Date(payload.retryAt) : null;

      return {
        kind: 'decision',
        id: r.id,
        caseId: r.caseId,
        at: r.occurredAt,
        event: r.kind,
        actor: r.actor,
        // The gate writes its verdict to `reason` on some events and into the
        // payload on others. Read both, so the sentence a person needs is never
        // the one field this happened not to look at.
        reason:
          (typeof payload.reason === 'string' ? payload.reason : null) ??
          r.reason ??
          (r.toState ? `→ ${r.toState}` : null),
        retryAt: retryAt && !Number.isNaN(retryAt.getTime()) ? retryAt : null,
        detail: typeof payload.note === 'string' ? payload.note : null,
      };
    }),
  ];

  return rows.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

export interface RecoverySummary {
  recoveredPaise: number;
  recoveredCases: number;
  /** Distinct root causes among the currently open cases. */
  failureClasses: number;
}

/**
 * All-time totals for the console's metric boxes.
 *
 * Deliberately no date window — unlike the Overview dashboard, the console is
 * about the state of the queue right now plus what this merchant has ever
 * recovered through it, not a period-over-period read.
 */
export async function getRecoverySummary(db: Database, merchantId: string): Promise<RecoverySummary> {
  const [row] = await db
    .select({
      recovered: sql`coalesce(sum(case when ${recoveryCases.state} = 'recovered' then coalesce(${recoveryCases.recoveredAmountPaise}, ${recoveryCases.amountAtRiskPaise}) else 0 end), 0)`,
      recoveredCases: sql`count(*) filter (where ${recoveryCases.state} = 'recovered')`,
      failureClasses: sql`count(distinct ${recoveryCases.causeClass}) filter (where ${recoveryCases.state} in ('detected','diagnosed','executing','paused'))`,
    })
    .from(recoveryCases)
    .where(eq(recoveryCases.merchantId, merchantId));

  return {
    recoveredPaise: paiseFromColumn(row?.recovered),
    recoveredCases: Number(row?.recoveredCases ?? 0),
    failureClasses: Number(row?.failureClasses ?? 0),
  };
}

export interface ConsoleMerchant {
  id: string;
  name: string;
  executionEnabled: boolean;
  dryRun: boolean;
  frequencyCapPerDay: number;
  quietHoursStart: number;
  quietHoursEnd: number;
  timezone: string;
  /**
   * Where messages actually land. Read from the same columns the senders read,
   * so the console cannot report a diversion that is not in force.
   */
  whatsappRedirectTo: string | null;
  emailRedirectTo: string | null;
  emailFrom: string | null;
}

/**
 * The merchant the console is operating on.
 *
 * Takes an explicit id. It used to return "the first merchant", which was
 * correct while there was one and silently wrong the moment there were two —
 * a Start click on the Sandbox page would have run a recovery on the live
 * account, using the live account's customers.
 */
export async function getConsoleMerchant(
  db: Database,
  merchantId: string,
): Promise<ConsoleMerchant | null> {
  const rows = await db
    .select()
    .from(merchants)
    .where(sql`${merchants.id} = ${merchantId} and deleted_at is null`)
    .limit(1);
  const m = rows.at(0);
  if (!m) return null;
  return {
    id: m.id,
    name: m.name,
    executionEnabled: m.executionEnabled,
    dryRun: m.dryRun,
    frequencyCapPerDay: m.frequencyCapPerDay,
    quietHoursStart: m.quietHoursStart,
    quietHoursEnd: m.quietHoursEnd,
    timezone: m.timezone,
    whatsappRedirectTo: m.whatsappRedirectTo,
    emailRedirectTo: m.emailRedirectTo,
    emailFrom: m.emailFrom,
  };
}
