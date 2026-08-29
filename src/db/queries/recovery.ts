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
import { recoveryCases } from '../schema/cases.js';
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

export interface ActivityRow {
  id: string;
  caseId: string | null;
  channel: string;
  intent: string;
  status: string;
  suppressedReason: string | null;
  providerMessageId: string | null;
  error: string | null;
  sentAt: Date;
  deliveredAt: Date | null;
}

/** Recent sends, newest first. The console's live feed. */
export async function getRecentActivity(
  db: Database,
  merchantId: string,
  limit = 25,
): Promise<ActivityRow[]> {
  const rows = await db
    .select()
    .from(messageLog)
    .where(eq(messageLog.merchantId, merchantId))
    .orderBy(desc(messageLog.sentAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    caseId: r.caseId,
    channel: r.channel,
    intent: r.intent,
    status: r.status,
    suppressedReason: r.suppressedReason,
    providerMessageId: r.providerMessageId,
    error: r.error,
    sentAt: r.sentAt,
    deliveredAt: r.deliveredAt,
  }));
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
}

export async function getConsoleMerchant(db: Database): Promise<ConsoleMerchant | null> {
  const rows = await db
    .select()
    .from(merchants)
    .where(sql`deleted_at is null`)
    .orderBy(merchants.createdAt)
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
  };
}
