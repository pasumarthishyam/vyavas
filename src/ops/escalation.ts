/**
 * Escalating a case to a person.
 *
 * Three steps, in an order that matters:
 *
 *   1. Gather the case from the ledger.        (cannot fail silently)
 *   2. Ask Claude for a brief.                 (allowed to fail)
 *   3. Write the queue row.                    (always happens)
 *
 * Step 3 does not depend on step 2. If Claude is unconfigured, slow, rate
 * limited or refuses, the row is still written with `fallbackBrief` and
 * `briefSource: 'fallback'`, and the escalation is still in front of a human.
 * A missing paragraph must never become a missing queue entry — the paragraph
 * is the improvement, the queue is the fix.
 */

import { and, asc, count, eq } from 'drizzle-orm';

import type { Paise } from '../core/money.js';
import type { CauseClass } from '../core/taxonomy/cause-class.js';
import type { EscalationQueue } from '../core/actions/types.js';

import type { Database } from '../db/client.js';
import { caseEvents, paymentAttempts, recoveryCases } from '../db/schema/cases.js';
import { merchants } from '../db/schema/tenancy.js';
import { createEscalation } from '../db/repos/escalations.js';
import { appendEvent } from '../db/repos/cases.js';
import { type BriefFacts, type LedgerEntry, fallbackBrief, writeBrief } from '../adapters/claude/index.js';

/**
 * How much of the ledger the brief sees.
 *
 * The oldest events are the ones that explain a case — `detected`, `diagnosed`,
 * `policy_resolved` — and the newest are the ones that explain why it stopped.
 * A busy case can carry a hundred `rung_deferred` rows in between that all say
 * the same thing, so the window is deliberately taken from both ends rather
 * than as a plain tail.
 */
const LEDGER_HEAD = 12;
const LEDGER_TAIL = 25;

/**
 * Kept short: this runs inside a ladder rung holding a workflow step open.
 *
 * The step is one HTTP invocation of `/api/inngest`, whose `maxDuration` is 60
 * seconds. 25s leaves comfortable room for the rest of the rung — the Razorpay
 * order re-check, the gate's queries, the action and event writes — and the
 * escalation row is written either way, so overrunning would cost the whole
 * step to buy prose we are happy to do without.
 */
const BRIEF_TIMEOUT_MS = 25_000;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Pull a human-readable note out of an event payload without trusting its shape. */
function noteFrom(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  for (const key of ['note', 'detail', 'reason', 'intent', 'action']) {
    const v = p[key];
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 200);
  }
  return null;
}

export interface GatherBriefOptions {
  db: Database;
  caseId: string;
  queue: EscalationQueue;
  policyNote: string | null;
  now: Date;
}

/** Everything the brief needs, read from the ledger. Null when the case is gone. */
export async function gatherBriefFacts(opts: GatherBriefOptions): Promise<BriefFacts | null> {
  const { db, caseId, now } = opts;

  const rows = await db
    .select({ c: recoveryCases, m: merchants })
    .from(recoveryCases)
    .innerJoin(merchants, eq(merchants.id, recoveryCases.merchantId))
    .where(eq(recoveryCases.id, caseId))
    .limit(1);

  const row = rows.at(0);
  if (!row) return null;
  const { c, m } = row;

  const events = await db
    .select({
      at: caseEvents.occurredAt,
      kind: caseEvents.kind,
      reason: caseEvents.reason,
      payload: caseEvents.payload,
    })
    .from(caseEvents)
    .where(eq(caseEvents.caseId, caseId))
    .orderBy(asc(caseEvents.occurredAt))
    .limit(500);

  const mapped: LedgerEntry[] = events.map((e) => ({
    at: e.at,
    kind: e.kind,
    reason: e.reason,
    note: noteFrom(e.payload),
  }));

  // Both ends, with the middle dropped — see LEDGER_HEAD.
  const ledger =
    mapped.length <= LEDGER_HEAD + LEDGER_TAIL
      ? mapped
      : [...mapped.slice(0, LEDGER_HEAD), ...mapped.slice(-LEDGER_TAIL)];

  let priorAttempts = 0;
  if (c.rzpOrderId) {
    const [n] = await db
      .select({ n: count() })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.merchantId, c.merchantId),
          eq(paymentAttempts.rzpOrderId, c.rzpOrderId),
        ),
      );
    priorAttempts = Number(n?.n ?? 0);
  }

  return {
    queue: opts.queue,
    merchantName: m.name,
    caseType: c.type,
    causeClass: c.causeClass,
    errorReason: c.errorReason,
    rawErrorReason: c.rawErrorReason,
    errorSource: c.errorSource,
    errorStep: c.errorStep,
    method: c.method,
    bank: c.bank,
    amountAtRisk: Number(c.amountAtRiskPaise) as Paise,
    attended: c.attended,
    confidence: c.confidence,
    policyId: c.policyId,
    diagnosisRationale: asStringArray(c.diagnosisRationale),
    ageMinutes: Math.max(0, Math.floor((now.getTime() - c.createdAt.getTime()) / 60_000)),
    messagesSent: c.messagesSent,
    priorAttempts,
    ledger,
    policyNote: opts.policyNote,
  };
}

export interface EscalateInput {
  db: Database;
  caseId: string;
  merchantId: string;
  queue: EscalationQueue;
  rung: number;
  /** From `idempotencyKey(caseId, action)` — never rebuilt here. */
  idempotencyKey: string;
  /** The `note` on the policy rung, which is why the ladder escalated. */
  policyNote: string | null;
  now: Date;
  /** Who escalated. `workflow` for the ladder, `console` for a hand-run script. */
  actor?: string;
  /** Skip the model. Set in dry-run and in tests. */
  skipBrief?: boolean;
}

export interface EscalateResult {
  escalationId: string | null;
  created: boolean;
  briefSource: 'claude' | 'fallback';
  /** Why the fallback was used, when it was. Null on success. */
  briefError: string | null;
}

/**
 * Put a case in front of a person, with a brief worth reading.
 *
 * Never throws for a Claude reason. The only failure mode that propagates is
 * the case having vanished, which is a genuine caller bug.
 */
export async function escalateCase(input: EscalateInput): Promise<EscalateResult> {
  const facts = await gatherBriefFacts({
    db: input.db,
    caseId: input.caseId,
    queue: input.queue,
    policyNote: input.policyNote,
    now: input.now,
  });

  if (!facts) {
    return { escalationId: null, created: false, briefSource: 'fallback', briefError: 'case not found' };
  }

  let brief = fallbackBrief(facts);
  let briefSource: 'claude' | 'fallback' = 'fallback';
  let briefError: string | null = input.skipBrief ? 'brief generation skipped' : null;

  if (!input.skipBrief) {
    const written = await writeBrief(facts, { timeoutMs: BRIEF_TIMEOUT_MS });
    if (written.ok) {
      brief = written.value;
      briefSource = 'claude';
    } else {
      briefError = `${written.error.failure}: ${written.error.detail}`.slice(0, 500);
    }
  }

  const result = await createEscalation(input.db, {
    caseId: input.caseId,
    merchantId: input.merchantId,
    queue: input.queue,
    rung: input.rung,
    idempotencyKey: input.idempotencyKey,
    headline: brief.headline,
    whatHappened: brief.whatHappened,
    whatWeTried: brief.whatWeTried,
    whatIsBlocking: brief.whatIsBlocking,
    recommendedAction: brief.recommendedAction,
    briefConfidence: brief.confidence,
    briefSource,
    briefError,
    amountAtRiskPaise: facts.amountAtRisk,
    causeClass: (facts.causeClass ?? null) as CauseClass | null,
  });

  /*
   * The audit trail entry is written HERE, not by the caller.
   *
   * It was the executor's job, which meant the ladder's escalations appeared in
   * the trail and the console script's did not — so a manual escalation created
   * a queue entry and a Claude call that the audit trail had no record of. The
   * function that performs the action is the only place that can guarantee
   * every path records it.
   *
   * Only on a real insert: a replay must not write a second event for one rung.
   */
  if (result.created) {
    await appendEvent(input.db, {
      caseId: input.caseId,
      merchantId: input.merchantId,
      kind: 'escalated',
      actor: input.actor ?? 'workflow',
      payload: {
        rung: input.rung,
        queue: input.queue,
        escalationId: result.id,
        briefSource,
        briefError,
      },
    });
  }

  return {
    escalationId: result.id,
    created: result.created,
    briefSource,
    briefError,
  };
}
