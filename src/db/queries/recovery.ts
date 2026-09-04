/**
 * The recovery console's data.
 *
 * One question per function, answered in one query. The console shows live
 * state and polls, so anything here runs every couple of seconds — it stays
 * narrow deliberately.
 */

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { paiseFromColumn } from '../util.js';
import { caseActions, caseEvents, recoveryCases } from '../schema/cases.js';
import { customers } from '../schema/customers.js';
import { merchants } from '../schema/tenancy.js';
import { merchantMembers } from '../schema/auth.js';
import { messageLog } from '../schema/messaging.js';
import { merchantAlerts } from '../schema/ops.js';
import { escalations } from '../schema/queues.js';
import { redactShort } from '../../lib/redact.js';
import type { CaseState } from '../../core/case/types.js';

const LIVE: CaseState[] = ['detected', 'diagnosed', 'executing', 'paused'];

/**
 * The single most recent thing that happened on a case — a send in flight or
 * settled, or a decision the gate made (deferred, aborted, diagnosed).
 *
 * Deliberately just the ONE latest row, not a history. That is what keeps this
 * free: no LLM call, no summarization, just a lookup through the same copy
 * tables the ladder detail page already uses (see `stepLine` in
 * `recovery-console.tsx`). The full trace still exists — it is the Activity
 * panel — this is only ever the newest line of it, rendered inline on the row
 * so "what is happening on this case right now" does not require a click.
 */
export interface CaseStep {
  at: Date;
  kind: 'message' | 'decision';
  channel: string | null;
  intent: string | null;
  status: string | null;
  suppressedReason: string | null;
  event: string | null;
  reason: string | null;
}

/**
 * The next thing scheduled for a case — a planned `case_actions` row that has
 * not fired yet, whether its time has already come (due, about to be picked up
 * on the next poll) or is still ahead (a countdown).
 *
 * Read from the ledger rather than tracked client-side. It used to be: the
 * console remembered `followUpAt` from the response to its own "start"
 * click, in a piece of React state that meant nothing to anyone who had not
 * personally pressed that button — reload the tab, or have a case started by
 * the real ladder instead of the console, and the countdown simply did not
 * exist. This is the same fact the scheduler itself reads to decide when to
 * fire, so it is true regardless of who is watching or when they opened the
 * page.
 */
export interface PlannedStep {
  at: Date;
  channel: string;
  intent: string;
}

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

  lastStep: CaseStep | null;
  nextAction: PlannedStep | null;
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

  const ids = rows.map((r) => r.c.id);
  const [steps, nextActions] = await Promise.all([
    getLatestStepsByCase(db, ids),
    getNextPlannedByCase(db, ids),
  ]);

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
    lastStep: steps.get(c.id) ?? null,
    nextAction: nextActions.get(c.id) ?? null,
  }));
}

/**
 * The earliest not-yet-executed planned action per case — `DISTINCT ON` the
 * case id, ordered ascending, so ties resolve to whichever fires first rather
 * than whichever the table happened to return first.
 */
async function getNextPlannedByCase(
  db: Database,
  caseIds: string[],
): Promise<Map<string, PlannedStep>> {
  if (caseIds.length === 0) return new Map();

  const rows = await db
    .selectDistinctOn([caseActions.caseId], {
      caseId: caseActions.caseId,
      scheduledFor: caseActions.scheduledFor,
      params: caseActions.params,
    })
    .from(caseActions)
    .where(
      and(
        inArray(caseActions.caseId, caseIds),
        eq(caseActions.status, 'planned'),
        isNull(caseActions.executedAt),
      ),
    )
    .orderBy(caseActions.caseId, asc(caseActions.scheduledFor));

  const map = new Map<string, PlannedStep>();
  for (const r of rows) {
    if (!r.caseId || !r.scheduledFor) continue;
    const params = (r.params ?? {}) as { channel?: string; intent?: string };
    map.set(r.caseId, {
      at: r.scheduledFor,
      channel: params.channel ?? 'email',
      intent: params.intent ?? 'switch_method',
    });
  }
  return map;
}

/**
 * One query per source table, each `DISTINCT ON` the case id and restricted
 * to an explicit id list — so this stays index-friendly (`case_id` is indexed
 * on both tables) and bounded to the ~50 open cases the console ever shows,
 * rather than scanning either table by merchant.
 */
async function getLatestStepsByCase(
  db: Database,
  caseIds: string[],
): Promise<Map<string, CaseStep>> {
  if (caseIds.length === 0) return new Map();

  const [messages, decisions] = await Promise.all([
    db
      .selectDistinctOn([messageLog.caseId], {
        caseId: messageLog.caseId,
        at: messageLog.sentAt,
        channel: messageLog.channel,
        intent: messageLog.intent,
        status: messageLog.status,
        suppressedReason: messageLog.suppressedReason,
      })
      .from(messageLog)
      .where(inArray(messageLog.caseId, caseIds))
      .orderBy(messageLog.caseId, desc(messageLog.sentAt)),
    db
      .selectDistinctOn([caseEvents.caseId], {
        caseId: caseEvents.caseId,
        at: caseEvents.occurredAt,
        event: caseEvents.kind,
        reason: caseEvents.reason,
      })
      .from(caseEvents)
      // Every kind the system records, so the row-level line can say "escalated"
      // or "payment received" rather than falling back to an older event that
      // happened to be on a shorter allowlist.
      .where(and(inArray(caseEvents.caseId, caseIds), inArray(caseEvents.kind, KNOWN_EVENT_KINDS)))
      .orderBy(caseEvents.caseId, desc(caseEvents.occurredAt)),
  ]);

  const steps = new Map<string, CaseStep>();

  for (const m of messages) {
    if (!m.caseId) continue;
    steps.set(m.caseId, {
      at: m.at,
      kind: 'message',
      channel: m.channel,
      intent: m.intent,
      status: m.status,
      suppressedReason: m.suppressedReason,
      event: null,
      reason: null,
    });
  }

  // A decision only wins the slot if it is strictly newer than the message
  // already there — a case whose latest thing was a send should keep showing
  // the send, not an older diagnosis event that happens to still be "notable".
  for (const d of decisions) {
    if (!d.caseId) continue;
    const existing = steps.get(d.caseId);
    if (existing && existing.at.getTime() >= d.at.getTime()) continue;
    steps.set(d.caseId, {
      at: d.at,
      kind: 'decision',
      channel: null,
      intent: null,
      status: null,
      suppressedReason: null,
      event: d.event,
      reason: redactShort(d.reason, 120),
    });
  }

  return steps;
}

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return '—';
  return `${user.slice(0, 3)}•••@${domain}`;
}

/**
 * Which lane an entry belongs to.
 *
 * The feed's job changed: it used to answer only "why has this case not been
 * paid yet", and it now has to be a complete audit trail — every action the
 * system or the model took. Forty undifferentiated rows is not a trail, it is a
 * wall, so the lane is what lets a reader ask a narrower question without
 * losing the guarantee that nothing was left out.
 *
 *   message   we contacted a customer, or tried to
 *   ai        Claude wrote something a person will read
 *   decision  the gate or the ladder chose to act, wait, or stop
 *   system    the case's own lifecycle — detected, diagnosed, paid, closed
 */
export type ActivityCategory = 'message' | 'ai' | 'decision' | 'system';

/** A message that was actually attempted. */
export interface MessageActivity {
  kind: 'message';
  category: 'message';
  id: string;
  caseId: string | null;
  at: Date;
  channel: string;
  intent: string;
  status: string;
  suppressedReason: string | null;
  providerMessageId: string | null;
  /** Redacted: providers echo the recipient inside failure messages. */
  error: string | null;
}

/** A decision the system made, whether or not it led to a message. */
export interface DecisionActivity {
  kind: 'decision';
  category: ActivityCategory;
  id: string;
  caseId: string | null;
  at: Date;
  /** `rung_deferred`, `diagnosed`, `state_changed`, `escalated`, … */
  event: string;
  actor: string;
  /** The gate's own words: why it deferred, aborted or moved on. Redacted. */
  reason: string | null;
  /** When the system intends to try again, when it said so. */
  retryAt: Date | null;
  /** Redacted. */
  detail: string | null;
}

export type ActivityRow = MessageActivity | DecisionActivity;

/**
 * Every event kind the system actually persists, and which lane it belongs to.
 *
 * This used to be a shorter allowlist called NOTABLE_EVENTS, chosen when the
 * feed answered one narrow question. It silently dropped five of the fifteen
 * kinds that reach the database — including `payment_received`, the moment the
 * money arrives, and both of the events the Claude jobs write. An audit trail
 * that omits the AI's own actions is not an audit trail.
 *
 * So the shape inverted: this is a COMPLETE map rather than a filter, and the
 * exhaustiveness test in the golden suite fails if an event kind is added to
 * the system without a lane here. An unknown kind still renders — it falls to
 * `system` rather than vanishing — because a trail that hides what it does not
 * recognise is the exact failure this replaced.
 */
export const EVENT_CATEGORY: Readonly<Record<string, ActivityCategory>> = {
  // The case's own lifecycle.
  detected: 'system',
  diagnosed: 'system',
  state_changed: 'system',
  payment_received: 'system',
  aborted: 'system',
  ladder_complete: 'system',

  // What the ladder and the gate chose to do.
  recovery_started: 'decision',
  rung_fired: 'decision',
  rung_deferred: 'decision',
  rung_aborted: 'decision',
  rung_abandoned: 'decision',
  rung_uncomposable: 'decision',
  payment_link_created: 'decision',
  // Parked because the merchant paused the agent. Both are `decision` rather
  // than `system`: a case that is sitting still because someone pressed a
  // button is the single most important thing to be able to see on its row, and
  // without a lane here it did not reach the console at all — the row showed
  // whatever older event happened to be on this allowlist, so a paused case
  // looked like a case that had simply stopped for no stated reason.
  rung_paused: 'decision',
  ladder_paused: 'decision',

  // What Claude wrote, and who it went to.
  escalated: 'ai',
  merchant_alerted: 'ai',
};

/** Unknown kinds land here rather than being dropped. */
export function categoryFor(kind: string): ActivityCategory {
  return EVENT_CATEGORY[kind] ?? 'system';
}

/**
 * Every kind above, as a list for `inArray`.
 *
 * Read at call time, not at module load, so the ordering of these two consts in
 * the file does not matter.
 */
const KNOWN_EVENT_KINDS = Object.keys(EVENT_CATEGORY);

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
    /*
     * `body` is deliberately NOT selected.
     *
     * It is the rendered message — the customer's first name, the amount, and
     * the payment link, which is a per-customer bearer URL. It belongs in the
     * ledger for a compliance review; it does not belong on a screen anyone
     * might screenshot. Naming the columns rather than `select()` is what makes
     * that a decision instead of an oversight the next `select()` undoes.
     */
    db
      .select({
        id: messageLog.id,
        caseId: messageLog.caseId,
        sentAt: messageLog.sentAt,
        channel: messageLog.channel,
        intent: messageLog.intent,
        status: messageLog.status,
        suppressedReason: messageLog.suppressedReason,
        providerMessageId: messageLog.providerMessageId,
        error: messageLog.error,
      })
      .from(messageLog)
      .where(eq(messageLog.merchantId, merchantId))
      .orderBy(desc(messageLog.sentAt))
      .limit(limit),
    // No kind filter: everything the system recorded appears. See EVENT_CATEGORY.
    db
      .select()
      .from(caseEvents)
      .where(eq(caseEvents.merchantId, merchantId))
      .orderBy(desc(caseEvents.occurredAt))
      .limit(limit),
  ]);

  const rows: ActivityRow[] = [...messages.map(toMessageActivity), ...decisions.map(toDecisionActivity)];

  return rows.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

type MessageRow = Pick<
  typeof messageLog.$inferSelect,
  | 'id'
  | 'caseId'
  | 'sentAt'
  | 'channel'
  | 'intent'
  | 'status'
  | 'suppressedReason'
  | 'providerMessageId'
  | 'error'
>;

function toMessageActivity(r: MessageRow): MessageActivity {
  return {
    kind: 'message',
    category: 'message',
    id: r.id,
    caseId: r.caseId,
    at: r.sentAt,
    channel: r.channel,
    intent: r.intent,
    status: r.status,
    suppressedReason: r.suppressedReason,
    providerMessageId: r.providerMessageId,
    // Meta and Resend both echo the recipient inside failure text. Masked here,
    // at the query layer, so no render site has to remember to.
    error: redactShort(r.error, 160),
  };
}

function toDecisionActivity(r: typeof caseEvents.$inferSelect): DecisionActivity {
  const payload = (r.payload ?? {}) as Record<string, unknown>;
  const retryAt = typeof payload.retryAt === 'string' ? new Date(payload.retryAt) : null;

  return {
    kind: 'decision',
    category: categoryFor(r.kind),
    id: r.id,
    caseId: r.caseId,
    at: r.occurredAt,
    event: r.kind,
    actor: r.actor,
    // The gate writes its verdict to `reason` on some events and into the
    // payload on others. Read both, so the sentence a person needs is never
    // the one field this happened not to look at.
    reason: redactShort(
      (typeof payload.reason === 'string' ? payload.reason : null) ??
        r.reason ??
        (r.toState ? `→ ${r.toState}` : null),
      160,
    ),
    retryAt: retryAt && !Number.isNaN(retryAt.getTime()) ? retryAt : null,
    detail: redactShort(detailFor(r.kind, payload), 200),
  };
}

/**
 * The one useful sentence for an event, from its payload.
 *
 * Per-kind rather than a blanket `payload.note`, because the interesting field
 * differs — and a generic reader shows nothing for exactly the events a person
 * most wants explained. Neither event the AI writes carries a `note` at all, so
 * under the old rule both appeared in the trail as a bare verb with no content.
 */
function detailFor(kind: string, payload: Record<string, unknown>): string | null {
  const str = (k: string): string | null =>
    typeof payload[k] === 'string' ? (payload[k] as string) : null;
  const num = (k: string): number | null =>
    typeof payload[k] === 'number' ? (payload[k] as number) : null;

  switch (kind) {
    case 'escalated': {
      const queue = str('queue')?.replace(/_/g, ' ') ?? 'a queue';
      // Naming the fallback reason here is the point: it is how a broken
      // integration shows up in the trail, not only on the queue card.
      return str('briefSource') === 'claude'
        ? `Claude wrote the brief · ${queue}`
        : `Brief fell back${str('briefError') ? ` — ${str('briefError')}` : ''} · ${queue}`;
    }

    case 'merchant_alerted': {
      const signal = str('signal');
      if (payload.raised === false) {
        return `No cluster for ${signal ?? 'this condition'} — nothing raised`;
      }
      const source = str('proseSource');
      return (
        `${signal ?? 'condition'} · ${num('affectedCases') ?? 0} case(s)` +
        (source ? ` · ${source === 'claude' ? 'Claude wrote it' : 'written without the model'}` : '')
      );
    }

    case 'rung_fired':
      return (
        [str('intent')?.replace(/_/g, ' '), str('channel')].filter(Boolean).join(' · ') || null
      );

    default:
      return str('note') ?? str('detail');
  }
}

/**
 * The full story of ONE case, newest first — every notable decision and every
 * send attempt, not just the latest. This is what the console's side drawer
 * reads: the row-level status line is deliberately only the newest entry of
 * exactly this list, so opening a case for the full picture never shows
 * anything the row's single line could not have summarised from.
 *
 * Scoped by merchant as well as case id, even though case ids are UUIDs and
 * effectively unguessable — a route that takes an id from the URL should not
 * be the one place in the app that skips the tenant check.
 */
export async function getCaseTrace(
  db: Database,
  merchantId: string,
  caseId: string,
  limit = 100,
): Promise<ActivityRow[]> {
  const [messages, decisions] = await Promise.all([
    // Same column list as the feed, for the same reason: `body` is the rendered
    // message and does not belong on a screen anyone might share.
    db
      .select({
        id: messageLog.id,
        caseId: messageLog.caseId,
        sentAt: messageLog.sentAt,
        channel: messageLog.channel,
        intent: messageLog.intent,
        status: messageLog.status,
        suppressedReason: messageLog.suppressedReason,
        providerMessageId: messageLog.providerMessageId,
        error: messageLog.error,
      })
      .from(messageLog)
      .where(and(eq(messageLog.merchantId, merchantId), eq(messageLog.caseId, caseId)))
      .orderBy(desc(messageLog.sentAt))
      .limit(limit),
    // Unfiltered. One case's own trace is exactly where "everything that
    // happened" is the point.
    db
      .select()
      .from(caseEvents)
      .where(and(eq(caseEvents.merchantId, merchantId), eq(caseEvents.caseId, caseId)))
      .orderBy(desc(caseEvents.occurredAt))
      .limit(limit),
  ]);

  const rows: ActivityRow[] = [...messages.map(toMessageActivity), ...decisions.map(toDecisionActivity)];
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

/* ── what needs a person ─────────────────────────────────────────────────── */

/**
 * An open escalation, shaped for the console.
 *
 * `briefSource` is the field to look at first, and it is why this is on the
 * console rather than only in `npm run queue`. Every Claude job in this system
 * fails soft — a model that is unreachable, slow, rate limited, or answering
 * with output that does not validate all take the deterministic fallback, and
 * the queue entry appears either way. That is correct behaviour and it makes
 * "the AI is working" invisible from the outside.
 *
 * So the provenance is carried to the surface: `claude` means the model read
 * this case and wrote the brief, `fallback` means it did not and `briefError`
 * says why. A queue that is all `fallback` is a broken integration, and without
 * this column it would look exactly like a working one.
 */
export interface ConsoleEscalation {
  id: string;
  caseId: string;
  queue: string;
  status: string;
  headline: string;
  whatHappened: string | null;
  whatWeTried: string | null;
  whatIsBlocking: string | null;
  /** Advice to the reader. Nothing automated consumes it. */
  recommendedAction: string | null;
  briefConfidence: string | null;
  /** `claude` or `fallback`. See the note above. */
  briefSource: string;
  briefError: string | null;
  amountPaise: number;
  causeClass: string | null;
  assignedTo: string | null;
  createdAt: Date;
}

export async function getOpenEscalations(
  db: Database,
  merchantId: string,
  limit = 25,
): Promise<ConsoleEscalation[]> {
  const rows = await db
    .select()
    .from(escalations)
    .where(
      and(
        eq(escalations.merchantId, merchantId),
        inArray(escalations.status, ['open', 'acknowledged']),
      ),
    )
    .orderBy(desc(escalations.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    caseId: r.caseId,
    queue: r.queue,
    status: r.status,
    headline: r.headline,
    whatHappened: r.whatHappened,
    whatWeTried: r.whatWeTried,
    whatIsBlocking: r.whatIsBlocking,
    recommendedAction: r.recommendedAction,
    briefConfidence: r.briefConfidence,
    briefSource: r.briefSource,
    briefError: r.briefError,
    amountPaise: paiseFromColumn(r.amountAtRiskPaise),
    causeClass: r.causeClass,
    assignedTo: r.assignedTo,
    createdAt: r.createdAt,
  }));
}

/** An open merchant alert — the other place Claude's writing reaches a person. */
export interface ConsoleAlert {
  id: string;
  signal: string;
  severity: string;
  title: string;
  detail: string | null;
  affectedCases: number;
  amountPaise: number;
  onsetAt: Date;
}

export async function getOpenAlerts(
  db: Database,
  merchantId: string,
  limit = 10,
): Promise<ConsoleAlert[]> {
  const rows = await db
    .select()
    .from(merchantAlerts)
    .where(and(eq(merchantAlerts.merchantId, merchantId), sql`resolved_at is null`))
    .orderBy(desc(merchantAlerts.onsetAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    signal: r.signal,
    severity: r.severity,
    title: r.title,
    detail: r.detail,
    affectedCases: r.affectedCases,
    amountPaise: paiseFromColumn(r.amountAtRiskPaise),
    onsetAt: r.onsetAt,
  }));
}

/**
 * Is the AI actually doing anything?
 *
 * The one honest answer available without calling the API: of the briefs
 * written so far, how many came from the model and how many from the fallback.
 * A run of nothing but fallbacks is the symptom of an expired key, a bad
 * request shape, or a schema the API rejects — all of which are otherwise
 * silent by design.
 *
 * `lastError` is the most recent reason a fallback was used, verbatim. It is
 * the difference between "not configured" and "400: schema rejected", which
 * look identical from anywhere else in the UI.
 */
export interface AiHealth {
  /** Whether an Anthropic key is present in this environment at all. */
  configured: boolean;
  briefsByClaude: number;
  briefsByFallback: number;
  lastError: string | null;
  lastWrittenAt: Date | null;
}

export async function getAiHealth(db: Database, merchantId: string): Promise<AiHealth> {
  const [row] = await db
    .select({
      claude: sql<number>`count(*) filter (where ${escalations.briefSource} = 'claude')::int`,
      fallback: sql<number>`count(*) filter (where ${escalations.briefSource} <> 'claude')::int`,
      lastWritten: sql<Date | null>`max(${escalations.createdAt}) filter (where ${escalations.briefSource} = 'claude')`,
    })
    .from(escalations)
    .where(eq(escalations.merchantId, merchantId));

  const [errRow] = await db
    .select({ err: escalations.briefError })
    .from(escalations)
    .where(and(eq(escalations.merchantId, merchantId), sql`brief_error is not null`))
    .orderBy(desc(escalations.createdAt))
    .limit(1);

  return {
    // Read here rather than in the client: an API key must never be sent to a
    // browser, and its mere presence is the only part the console needs.
    configured: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    briefsByClaude: Number(row?.claude ?? 0),
    briefsByFallback: Number(row?.fallback ?? 0),
    lastError: errRow?.err ?? null,
    lastWrittenAt: row?.lastWritten ? new Date(row.lastWritten) : null,
  };
}

/** Case ids with an open escalation, for the console's "Needs a person" filter. */
export async function getEscalatedCaseIds(
  db: Database,
  merchantId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ caseId: escalations.caseId })
    .from(escalations)
    .where(
      and(
        eq(escalations.merchantId, merchantId),
        inArray(escalations.status, ['open', 'acknowledged']),
      ),
    );
  return rows.map((r) => r.caseId);
}

export interface ConsoleMerchant {
  id: string;
  name: string;
  executionEnabled: boolean;
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
    frequencyCapPerDay: m.frequencyCapPerDay,
    quietHoursStart: m.quietHoursStart,
    quietHoursEnd: m.quietHoursEnd,
    timezone: m.timezone,
    whatsappRedirectTo: m.whatsappRedirectTo,
    emailRedirectTo: m.emailRedirectTo,
    emailFrom: m.emailFrom,
  };
}

/**
 * The same thing, resolved from the console's cookie in ONE query.
 *
 * The status route used to call `currentMerchantId` — which selects every
 * merchant to resolve the slug — and then `getConsoleMerchant`, which selects
 * the very same row again. Two round trips for one answer, on a route the
 * console polls every few seconds. That is the hottest query path in the app
 * and it was doing twice the work it needed to.
 *
 * Keeps the rule that matters: an unrecognised or missing selection falls back
 * to the FIRST merchant, never to "all merchants". A console that silently
 * aggregated two accounts would make a Start click ambiguous about whose
 * customers were about to be messaged.
 *
 * ── the membership join is not optional ──
 *
 * `slug` comes from a cookie, which is set by the browser and therefore
 * attacker-controlled. Without the join this function would happily hand back
 * any merchant in the database to any signed-in user who edited one cookie
 * value — every case, every masked contact, and the send-mode switch. The join
 * costs nothing here because it is the same single query.
 */
export async function getConsoleMerchantBySlug(
  db: Database,
  slug: string | null,
  userId: string,
): Promise<ConsoleMerchant | null> {
  const rows = await db
    .select({ m: merchants })
    .from(merchants)
    .innerJoin(merchantMembers, eq(merchantMembers.merchantId, merchants.id))
    .where(and(eq(merchantMembers.userId, userId), sql`${merchants.deletedAt} is null`))
    .orderBy(merchants.createdAt);

  const found = (slug ? rows.find((r) => r.m.slug === slug) : undefined) ?? rows.at(0);
  if (!found) return null;
  const m = found.m;

  return {
    id: m.id,
    name: m.name,
    executionEnabled: m.executionEnabled,
    frequencyCapPerDay: m.frequencyCapPerDay,
    quietHoursStart: m.quietHoursStart,
    quietHoursEnd: m.quietHoursEnd,
    timezone: m.timezone,
    whatsappRedirectTo: m.whatsappRedirectTo,
    emailRedirectTo: m.emailRedirectTo,
    emailFrom: m.emailFrom,
  };
}
