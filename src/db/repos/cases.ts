/**
 * The case repository.
 *
 * Two things here are worth reading carefully:
 *
 *  1. `transitionCase` runs core's state machine BEFORE it writes. The database
 *     is not a second source of truth about what transitions are legal — core
 *     decides, the database records. That is what keeps "a recovered case never
 *     reopens" a single rule rather than two rules that can disagree.
 *
 *  2. `createCase` leans on the partial unique index rather than checking first.
 *     A SELECT-then-INSERT would race between two failed attempts on the same
 *     order arriving milliseconds apart, and the customer would get two ladders.
 */

import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import type { CaseState, CaseType, Cohort } from '../../core/case/types.js';
import { transition, type TransitionReason } from '../../core/case/machine.js';
import type { CauseClass } from '../../core/taxonomy/cause-class.js';
import type { Database } from '../client.js';
import { caseEvents, paymentAttempts, recoveryCases } from '../schema/cases.js';
import { customers } from '../schema/customers.js';
import { merchants } from '../schema/tenancy.js';

const LIVE_STATES: CaseState[] = ['detected', 'diagnosed', 'executing', 'paused'];

export interface CreateCaseInput {
  merchantId: string;
  customerId: string | null;
  type: CaseType;
  amountAtRiskPaise: number;
  currency?: string;

  rzpOrderId?: string | null;
  rzpPaymentId?: string | null;
  rzpInvoiceId?: string | null;
  rzpSubscriptionId?: string | null;

  errorCode?: string | null;
  errorSource?: string | null;
  errorStep?: string | null;
  errorReason?: string | null;
  rawErrorReason?: string | null;
  method?: string;
  bank?: string | null;
  network?: string | null;

  causeClass?: CauseClass | null;
  confidence?: string | null;
  diagnosisRationale?: readonly string[] | null;
  attended: boolean;
  mandateId?: string | null;

  policyId?: string | null;
  policyVersion?: number | null;
  cohort?: Cohort;
  deadlineAt?: Date | null;
}

/**
 * Create a case, or return the existing live one for this order.
 *
 * Idempotent by construction: the partial unique index on live cases per order
 * makes a duplicate insert a no-op, and we then read back the incumbent.
 */
export async function createCase(
  db: Database,
  input: CreateCaseInput,
): Promise<{ id: string; created: boolean }> {
  const values = {
    merchantId: input.merchantId,
    customerId: input.customerId,
    type: input.type,
    amountAtRiskPaise: input.amountAtRiskPaise,
    currency: input.currency ?? 'INR',
    rzpOrderId: input.rzpOrderId ?? null,
    rzpPaymentId: input.rzpPaymentId ?? null,
    rzpInvoiceId: input.rzpInvoiceId ?? null,
    rzpSubscriptionId: input.rzpSubscriptionId ?? null,
    errorCode: input.errorCode ?? null,
    errorSource: (input.errorSource ?? null) as never,
    errorStep: (input.errorStep ?? null) as never,
    errorReason: input.errorReason ?? null,
    rawErrorReason: input.rawErrorReason ?? null,
    method: (input.method ?? 'unknown') as never,
    bank: input.bank ?? null,
    network: input.network ?? null,
    causeClass: (input.causeClass ?? null) as never,
    confidence: input.confidence ?? null,
    diagnosisRationale: (input.diagnosisRationale ?? null) as never,
    attended: input.attended,
    mandateId: input.mandateId ?? null,
    policyId: input.policyId ?? null,
    policyVersion: input.policyVersion ?? null,
    cohort: input.cohort ?? 'treatment',
    deadlineAt: input.deadlineAt ?? null,
  };

  const inserted = await db
    .insert(recoveryCases)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: recoveryCases.id });

  const row = inserted.at(0);
  if (row) {
    await appendEvent(db, {
      caseId: row.id,
      merchantId: input.merchantId,
      kind: 'detected',
      toState: 'detected',
      actor: 'webhook',
      payload: { amountAtRiskPaise: input.amountAtRiskPaise, errorReason: input.errorReason },
    });
    return { id: row.id, created: true };
  }

  const existing = await findLiveCaseForOrder(db, input.merchantId, input.rzpOrderId ?? null);
  if (!existing) {
    throw new Error(
      'Case insert conflicted but no live case was found. This means a unique index other ' +
        'than the live-order guard rejected the row — inspect the input rather than retrying.',
    );
  }
  return { id: existing.id, created: false };
}

export async function findLiveCaseForOrder(
  db: Database,
  merchantId: string,
  rzpOrderId: string | null,
) {
  if (!rzpOrderId) return null;
  const rows = await db
    .select()
    .from(recoveryCases)
    .where(
      and(
        eq(recoveryCases.merchantId, merchantId),
        eq(recoveryCases.rzpOrderId, rzpOrderId),
        inArray(recoveryCases.state, LIVE_STATES),
      ),
    )
    .limit(1);
  return rows.at(0) ?? null;
}

export async function getCase(db: Database, caseId: string) {
  const rows = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseId)).limit(1);
  return rows.at(0) ?? null;
}

/**
 * The live case that created this Razorpay payment link.
 *
 * The fallback path for resolving a `payment_link.paid` when the link carries
 * no usable `reference_id` — a link created before that field was set, or one
 * created by hand in the Razorpay dashboard against a case.
 */
export async function findLiveCaseForPaymentLink(
  db: Database,
  merchantId: string,
  paymentLinkId: string | null,
) {
  if (!paymentLinkId) return null;
  const rows = await db
    .select()
    .from(recoveryCases)
    .where(
      and(
        eq(recoveryCases.merchantId, merchantId),
        eq(recoveryCases.rzpPaymentLinkId, paymentLinkId),
        inArray(recoveryCases.state, LIVE_STATES),
      ),
    )
    .limit(1);
  return rows.at(0) ?? null;
}

/**
 * Live cases with a recovery link outstanding — what the reconciliation sweep
 * scans.
 *
 * The backstop for a missed `payment_link.paid` delivery. Without it the only
 * thing that ever closes a link-paid case is the webhook, and a webhook that
 * does not arrive means a customer who paid still gets the next rung and the
 * case is written off as lost.
 */
export async function listCasesAwaitingLinkPayment(db: Database, limit = 200) {
  return db
    .select({
      id: recoveryCases.id,
      merchantId: recoveryCases.merchantId,
      rzpPaymentLinkId: recoveryCases.rzpPaymentLinkId,
      amountAtRiskPaise: recoveryCases.amountAtRiskPaise,
      cohort: recoveryCases.cohort,
      createdAt: recoveryCases.createdAt,
    })
    .from(recoveryCases)
    .where(
      and(
        inArray(recoveryCases.state, LIVE_STATES),
        sql`${recoveryCases.rzpPaymentLinkId} is not null`,
        isNull(recoveryCases.resolvedAt),
      ),
    )
    .limit(limit);
}

export interface TransitionResult {
  ok: boolean;
  from: CaseState;
  to: CaseState;
  reason: string;
}

/**
 * Move a case to a new state.
 *
 * Core's state machine validates first; the UPDATE then re-asserts the observed
 * state in its WHERE clause, so a concurrent transition loses rather than
 * silently overwriting. Returns `ok: false` on a lost race — which is an
 * ordinary outcome (two workers seeing one payment), not an error.
 */
export async function transitionCase(
  db: Database,
  caseId: string,
  to: CaseState,
  reason: TransitionReason,
  extra: { recoveredAmountPaise?: number | null; actor?: string } = {},
): Promise<TransitionResult> {
  const current = await getCase(db, caseId);
  if (!current) throw new Error(`Case ${caseId} not found`);

  const check = transition(current.state, to, reason);
  if (!check.ok) {
    return { ok: false, from: current.state, to, reason: check.error.message };
  }

  const isTerminal = to === 'recovered' || to === 'lost' || to === 'aborted';

  const updated = await db
    .update(recoveryCases)
    .set({
      state: to,
      updatedAt: sql`now()`,
      ...(isTerminal ? { resolvedAt: sql`now()` } : {}),
      ...(extra.recoveredAmountPaise != null
        ? { recoveredAmountPaise: extra.recoveredAmountPaise }
        : {}),
    })
    // Optimistic concurrency: only move if the state is still what we read.
    .where(and(eq(recoveryCases.id, caseId), eq(recoveryCases.state, current.state)))
    .returning({ id: recoveryCases.id });

  if (updated.length === 0) {
    return {
      ok: false,
      from: current.state,
      to,
      reason: 'lost a concurrent transition race; another worker moved this case first',
    };
  }

  await appendEvent(db, {
    caseId,
    merchantId: current.merchantId,
    kind: 'state_changed',
    fromState: current.state,
    toState: to,
    reason,
    actor: extra.actor ?? 'workflow',
  });

  return { ok: true, from: current.state, to, reason };
}

/**
 * Has this customer attempted a payment at this merchant, and is one being
 * recovered right now?
 *
 * The join between the two agents. `abandoned_carts` carries no order id and no
 * payment reference — there was no payment, which is the whole reason that
 * table exists — so the customer row is the only thing the two share.
 *
 * One query returns both facts because they answer one question and must
 * describe the same instant: read separately, a case could resolve between them
 * and the caller would see "no live case, no recent case" for someone whose
 * ladder finished a second ago.
 */
export async function recentCaseActivityForCustomer(
  db: Database,
  merchantId: string,
  customerId: string,
): Promise<{ hasLiveCase: boolean; mostRecentCaseAt: Date | null }> {
  const [row] = await db
    .select({
      live: sql<number>`count(*) filter (where ${recoveryCases.state} in ('detected','diagnosed','executing','paused'))::int`,
      mostRecent: sql<Date | null>`max(${recoveryCases.createdAt})`,
    })
    .from(recoveryCases)
    .where(
      and(eq(recoveryCases.merchantId, merchantId), eq(recoveryCases.customerId, customerId)),
    );

  return {
    hasLiveCase: Number(row?.live ?? 0) > 0,
    mostRecentCaseAt: row?.mostRecent ? new Date(row.mostRecent) : null,
  };
}

// ─── pause and resume ────────────────────────────────────────────────────────

export interface ResumedCase {
  id: string;
  merchantId: string;
  policyId: string | null;
  policyVersion: number | null;
  causeClass: string | null;
  cohort: string;
  attended: boolean;
  /** Unique per resume. Becomes the Inngest run key. */
  resumeCount: number;
}

/**
 * Claim one paused case and hand back everything needed to restart its ladder.
 *
 * THE CLAIM IS THE UPDATE. Two things resume a case — a person switching the
 * account back to live, and the sweep that catches what that missed — and they
 * can fire at the same moment on the same row. `WHERE state = 'paused'` means
 * exactly one of them gets a row back; the loser sees zero rows and does
 * nothing. Checking first and updating second would let both read `paused`,
 * both publish, and Inngest start two ladders on one case, which is two of
 * every remaining message to a real person.
 *
 * `resume_count` is incremented in the same statement because it is what makes
 * the republished event's key unique. `run-ladder` dedupes on that key, so
 * resuming under the original key would be swallowed by the very guard that
 * stops duplicate ladders, and the case would sit in `executing` with nothing
 * running behind it.
 *
 * Returns null when the case was not paused — already resumed, already
 * recovered, or never paused at all. That is an ordinary outcome, not an error.
 */
export async function claimPausedCaseForResume(
  db: Database,
  caseId: string,
): Promise<ResumedCase | null> {
  const updated = await db
    .update(recoveryCases)
    .set({
      state: 'executing',
      resumeCount: sql`${recoveryCases.resumeCount} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(recoveryCases.id, caseId), eq(recoveryCases.state, 'paused')))
    .returning({
      id: recoveryCases.id,
      merchantId: recoveryCases.merchantId,
      policyId: recoveryCases.policyId,
      policyVersion: recoveryCases.policyVersion,
      causeClass: recoveryCases.causeClass,
      cohort: recoveryCases.cohort,
      attended: recoveryCases.attended,
      resumeCount: recoveryCases.resumeCount,
    });

  const row = updated.at(0);
  if (!row) return null;

  await appendEvent(db, {
    caseId,
    merchantId: row.merchantId,
    kind: 'state_changed',
    fromState: 'paused',
    toState: 'executing',
    reason: 'resumed',
    actor: 'merchant',
    payload: { resumeCount: row.resumeCount },
  });

  return { ...row, resumeCount: Number(row.resumeCount) };
}

export interface PausedCaseRow {
  id: string;
  amountAtRiskPaise: number;
  causeClass: string | null;
  errorReason: string | null;
  method: string;
  createdAt: Date;
  deadlineAt: Date | null;
  messagesSent: number;
  /** Masked. This list is rendered in an overlay someone may screenshot. */
  customerContact: string | null;
}

/**
 * Paused cases belonging to a merchant, oldest first, with enough detail to
 * show a person what resuming would actually do.
 *
 * Ordered oldest-first because that is the order the operator cares about: the
 * cases at the top are the ones most likely to be too old to wake, and seeing
 * them first is what makes the confirmation overlay a decision rather than a
 * formality.
 */
export async function listPausedCases(
  db: Database,
  merchantId: string,
  limit = 500,
): Promise<PausedCaseRow[]> {
  const rows = await db
    .select({
      id: recoveryCases.id,
      amountAtRiskPaise: recoveryCases.amountAtRiskPaise,
      causeClass: recoveryCases.causeClass,
      errorReason: recoveryCases.errorReason,
      method: recoveryCases.method,
      createdAt: recoveryCases.createdAt,
      deadlineAt: recoveryCases.deadlineAt,
      messagesSent: recoveryCases.messagesSent,
      phone: customers.phone,
      email: customers.email,
    })
    .from(recoveryCases)
    .leftJoin(customers, eq(customers.id, recoveryCases.customerId))
    .where(and(eq(recoveryCases.merchantId, merchantId), eq(recoveryCases.state, 'paused')))
    .orderBy(recoveryCases.createdAt)
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    amountAtRiskPaise: Number(r.amountAtRiskPaise),
    causeClass: r.causeClass,
    errorReason: r.errorReason,
    method: r.method,
    createdAt: r.createdAt,
    deadlineAt: r.deadlineAt,
    messagesSent: r.messagesSent,
    customerContact: maskContact(r.phone, r.email),
  }));
}

/** Masked at the query layer, never in the view. A screenshot must not carry a number. */
function maskContact(phone: string | null, email: string | null): string | null {
  if (phone) return `${phone.slice(0, 3)}•••••${phone.slice(-4)}`;
  if (email) {
    const [user, domain] = email.split('@');
    if (!user || !domain) return null;
    return `${user.slice(0, 2)}•••@${domain}`;
  }
  return null;
}

/**
 * Put a case back to `paused` after a resume that could not be completed.
 *
 * The claim and the publish are two steps and the second one can fail — Inngest
 * unreachable, a missing event key, a network blip. Leaving the case in
 * `executing` after that is the worst of both: the state says a ladder is
 * running, none is, and nothing looks for it, because every sweep and every
 * resume path scans `paused`. The case would sit there until its deadline
 * quietly wrote it off, having sent nothing and reported nothing.
 *
 * Guarded on `executing` so it can only undo a claim this process just made,
 * never yank a case out from under a ladder that did start.
 */
export async function repausePausedCase(
  db: Database,
  caseId: string,
  detail: string,
): Promise<boolean> {
  const updated = await db
    .update(recoveryCases)
    .set({ state: 'paused', updatedAt: sql`now()` })
    .where(and(eq(recoveryCases.id, caseId), eq(recoveryCases.state, 'executing')))
    .returning({ id: recoveryCases.id, merchantId: recoveryCases.merchantId });

  const row = updated.at(0);
  if (!row) return false;

  await appendEvent(db, {
    caseId,
    merchantId: row.merchantId,
    kind: 'ladder_paused',
    fromState: 'executing',
    toState: 'paused',
    reason: 'resume_failed',
    actor: 'workflow',
    payload: { detail },
  });

  return true;
}

/**
 * Close a paused case that will not be resumed.
 *
 * The same conditional-UPDATE claim as `claimPausedCaseForResume`, for the same
 * reason: the switch and the sweep can both decide to close the same case, and
 * only one of them may write the outcome.
 */
export async function closePausedCase(
  db: Database,
  caseId: string,
  reason: 'stale_after_pause' | 'manual_abort' | 'deadline_passed',
  detail: string,
): Promise<boolean> {
  const toState = reason === 'deadline_passed' ? 'lost' : 'aborted';

  const updated = await db
    .update(recoveryCases)
    .set({ state: toState, resolvedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(recoveryCases.id, caseId), eq(recoveryCases.state, 'paused')))
    .returning({ id: recoveryCases.id, merchantId: recoveryCases.merchantId });

  const row = updated.at(0);
  if (!row) return false;

  await appendEvent(db, {
    caseId,
    merchantId: row.merchantId,
    kind: 'state_changed',
    fromState: 'paused',
    toState,
    reason,
    actor: 'merchant',
    payload: { detail },
  });

  return true;
}

/**
 * Every paused case whose merchant is live again, across all tenants.
 *
 * What the sweep scans. The join is the whole point: a case is only resumed
 * when its own merchant is no longer paused, so pausing an account and leaving
 * it paused does not slowly leak cases back into execution.
 */
export async function listResumableCases(
  db: Database,
  limit = 200,
): Promise<{ id: string; merchantId: string; createdAt: Date; deadlineAt: Date | null }[]> {
  return db
    .select({
      id: recoveryCases.id,
      merchantId: recoveryCases.merchantId,
      // Carried so the sweep can apply the SAME staleness rule the console
      // path does, rather than waking a case the button would have refused.
      createdAt: recoveryCases.createdAt,
      deadlineAt: recoveryCases.deadlineAt,
    })
    .from(recoveryCases)
    .innerJoin(merchants, eq(merchants.id, recoveryCases.merchantId))
    .where(
      and(
        eq(recoveryCases.state, 'paused'),
        eq(merchants.executionEnabled, true),
        sql`${merchants.deletedAt} is null`,
      ),
    )
    .orderBy(recoveryCases.createdAt)
    .limit(limit);
}

export interface AppendEventInput {
  caseId: string;
  merchantId: string;
  kind: string;
  fromState?: CaseState | null;
  toState?: CaseState | null;
  reason?: string | null;
  actor?: string;
  payload?: unknown;
}

/** Append-only. Never updated, never deleted. */
export async function appendEvent(db: Database, input: AppendEventInput): Promise<void> {
  await db.insert(caseEvents).values({
    caseId: input.caseId,
    merchantId: input.merchantId,
    kind: input.kind,
    fromState: (input.fromState ?? null) as never,
    toState: (input.toState ?? null) as never,
    reason: input.reason ?? null,
    actor: input.actor ?? 'system',
    payload: (input.payload ?? null) as never,
  });
}

export async function listCaseEvents(db: Database, caseId: string) {
  return db
    .select()
    .from(caseEvents)
    .where(eq(caseEvents.caseId, caseId))
    .orderBy(caseEvents.occurredAt);
}

/**
 * Prior attempts on an order, for `DiagnoseContext.priorAttempts`.
 *
 * This is what withdraws same-instrument retry before a third wrong OTP costs
 * the customer their card.
 */
export async function listAttemptsForOrder(
  db: Database,
  merchantId: string,
  rzpOrderId: string,
) {
  return db
    .select()
    .from(paymentAttempts)
    .where(
      and(eq(paymentAttempts.merchantId, merchantId), eq(paymentAttempts.rzpOrderId, rzpOrderId)),
    )
    .orderBy(paymentAttempts.attemptedAt);
}

export async function recordAttempt(
  db: Database,
  input: {
    merchantId: string;
    caseId?: string | null;
    rzpOrderId: string | null;
    rzpPaymentId: string;
    method?: string;
    errorReason?: string | null;
    errorSource?: string | null;
    bank?: string | null;
    succeeded?: boolean;
    amountPaise: number;
    attemptedAt: Date;
  },
): Promise<void> {
  await db
    .insert(paymentAttempts)
    .values({
      merchantId: input.merchantId,
      caseId: input.caseId ?? null,
      rzpOrderId: input.rzpOrderId,
      rzpPaymentId: input.rzpPaymentId,
      method: (input.method ?? 'unknown') as never,
      errorReason: input.errorReason ?? null,
      errorSource: (input.errorSource ?? null) as never,
      bank: input.bank ?? null,
      succeeded: input.succeeded ?? false,
      amountPaise: input.amountPaise,
      attemptedAt: input.attemptedAt,
    })
    .onConflictDoNothing({
      target: [paymentAttempts.merchantId, paymentAttempts.rzpPaymentId],
    });
}

/**
 * Has this customer tried to pay in the last few minutes?
 *
 * The live-attempt lock. Messaging someone who is mid-retry on another card is
 * worse than saying nothing.
 */
export async function hasLiveAttempt(
  db: Database,
  merchantId: string,
  rzpOrderId: string,
  withinMinutes: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.merchantId, merchantId),
        eq(paymentAttempts.rzpOrderId, rzpOrderId),
        sql`${paymentAttempts.attemptedAt} > now() - make_interval(mins => ${withinMinutes})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Live cases past their deadline.
 *
 * `FOR UPDATE SKIP LOCKED` lets many workers sweep in parallel without two of
 * them claiming the same case — the standard queue-claim pattern, and one
 * Drizzle expresses directly.
 */
export async function claimExpiredCases(db: Database, limit = 100) {
  return db
    .select()
    .from(recoveryCases)
    .where(
      and(
        inArray(recoveryCases.state, LIVE_STATES),
        lt(recoveryCases.deadlineAt, sql`now()`),
        isNull(recoveryCases.resolvedAt),
      ),
    )
    .limit(limit)
    .for('update', { skipLocked: true });
}
