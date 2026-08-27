/**
 * Rung execution.
 *
 * One function, `executeRung`, called once per ladder step. It is the only
 * place in the system where an action becomes a real thing in the world, which
 * is why every guard converges here rather than being scattered across the
 * workflow.
 *
 * In Stage 6 the channel layer is a no-op. Every rung is planned, gated,
 * recorded and then deliberately not sent. That is not a placeholder — it is
 * the product: a merchant watches two weeks of their real traffic and sees
 * exactly what would have been said, to whom, and when, before granting write
 * access to anything.
 *
 * Three suppression reasons, and they are NOT the same thing:
 *
 *   holdout    a real control group. Runs the full ladder, sends nothing, and
 *              is the only honest way to know what recovery was worth.
 *   dry_run    the merchant has not turned execution on yet.
 *   not_built  the channel does not exist yet (all of Stage 6).
 *
 * Collapsing them would make the incrementality report meaningless, because a
 * dry-run case is not a control — it is a case we never treated at all.
 */

import { eq, sql } from 'drizzle-orm';

import { type Action, idempotencyKey } from '../core/actions/types.js';
import { effectiveRails } from '../core/policy/resolve.js';
import { evaluatePreconditions, selectChannel } from '../core/guards/preconditions.js';
import type { GateResult } from '../core/guards/preconditions.js';
import type { LadderRung, PolicyRow } from '../core/policy/schema.js';
import type { Diagnosis } from '../core/taxonomy/diagnose.js';
import type { AlternateRail } from '../core/case/types.js';

import type { Database } from '../db/client.js';
import { caseActions, recoveryCases } from '../db/schema/cases.js';
import { appendEvent } from '../db/repos/cases.js';
import { recordMessageIfPermitted } from '../db/repos/messages.js';
import type { GatheredFacts } from './facts.js';

export type SuppressionReason = 'holdout' | 'dry_run' | 'not_built';

export interface ExecuteRungInput {
  db: Database;
  caseId: string;
  merchantId: string;
  rungIndex: number;
  rung: LadderRung;
  policy: PolicyRow;
  gathered: GatheredFacts;
  cohort: 'treatment' | 'holdout';
  /** Rails the diagnosis permits. Used to filter what a nudge may suggest. */
  diagnosisRails: readonly AlternateRail[];
  sameInstrumentRetry: boolean;
}

export interface RungOutcome {
  disposition: 'executed' | 'suppressed' | 'skipped' | 'deferred' | 'aborted';
  gate: GateResult;
  suppressedReason: SuppressionReason | null;
  action: Action | null;
  channel: string | null;
  retryAt: Date | null;
  note: string;
}

/**
 * Run one rung.
 *
 * Order: gate first, then decide whether the action is sent or suppressed.
 * Suppression happens AFTER the gate on purpose — a holdout case must be gated
 * identically to a treatment case, or the two groups are not comparable and the
 * incrementality number is a guess.
 */
export async function executeRung(input: ExecuteRungInput): Promise<RungOutcome> {
  const { db, caseId, merchantId, rungIndex, rung, policy, gathered, cohort } = input;

  const gate = evaluatePreconditions(policy.preconditions, gathered.facts);

  if (gate.disposition === 'abort') {
    await appendEvent(db, {
      caseId,
      merchantId,
      kind: 'rung_aborted',
      reason: gate.failed ?? 'precondition',
      actor: 'workflow',
      payload: { rung: rungIndex, reason: gate.reason, at: rung.at },
    });
    return {
      disposition: 'aborted',
      gate,
      suppressedReason: null,
      action: null,
      channel: null,
      retryAt: null,
      note: gate.reason,
    };
  }

  if (gate.disposition === 'defer') {
    await appendEvent(db, {
      caseId,
      merchantId,
      kind: 'rung_deferred',
      reason: gate.failed ?? 'precondition',
      actor: 'workflow',
      payload: { rung: rungIndex, reason: gate.reason, retryAt: gate.retryAt?.toISOString() },
    });
    return {
      disposition: 'deferred',
      gate,
      suppressedReason: null,
      action: null,
      channel: null,
      retryAt: gate.retryAt,
      note: gate.reason,
    };
  }

  // ── build the typed action ──
  const built = buildAction(input);
  if (!built) {
    return {
      disposition: 'skipped',
      gate,
      suppressedReason: null,
      action: null,
      channel: null,
      retryAt: null,
      note: `no eligible channel for a ${rung.action} rung`,
    };
  }

  const { action, channel } = built;
  const key = idempotencyKey(caseId, action);

  // ── why this will not actually send ──
  //
  // Ordered by precedence: a holdout case is a holdout case even once the
  // channels are built and the merchant has turned execution on.
  const suppressedReason: SuppressionReason =
    cohort === 'holdout' ? 'holdout' : gathered.dryRun ? 'dry_run' : 'not_built';

  // ── record the action ──
  //
  // ON CONFLICT DO NOTHING on the idempotency key: a workflow replay after a
  // deploy must not fire the same rung twice.
  const inserted = await db
    .insert(caseActions)
    .values({
      caseId,
      merchantId,
      rung: rungIndex,
      kind: action.kind,
      status: 'suppressed',
      idempotencyKey: key,
      skipReason: suppressedReason,
      params: action as never,
      scheduledFor: gathered.facts.now,
      executedAt: gathered.facts.now,
    })
    .onConflictDoNothing({ target: caseActions.idempotencyKey })
    .returning({ id: caseActions.id });

  if (inserted.length === 0) {
    return {
      disposition: 'skipped',
      gate,
      suppressedReason,
      action,
      channel,
      retryAt: null,
      note: 'this rung has already been recorded — replay',
    };
  }

  // ── the message ledger ──
  //
  // Written even when suppressed, and through the SAME locked path a real send
  // would take. That is what makes the two cohorts comparable: a holdout row
  // records that we got as far as being permitted to send.
  if (channel && (action.kind === 'nudge' || action.kind === 'send_pre_debit_notice')) {
    if (gathered.customerId) {
      const decision = await recordMessageIfPermitted(
        db,
        {
          merchantId,
          customerId: gathered.customerId,
          caseId,
          rung: rungIndex,
          channel: channel as 'whatsapp' | 'sms' | 'email' | 'in_app',
          intent: action.kind === 'nudge' ? action.intent : 'pre_debit_notice',
          idempotencyKey: key,
          suppressedReason,
        },
        gathered.facts.frequencyCap,
      );

      if (!decision.permitted) {
        return {
          disposition: 'skipped',
          gate,
          suppressedReason,
          action,
          channel,
          retryAt: null,
          note: `message ledger refused: ${decision.reason}`,
        };
      }
    }

    await db
      .update(recoveryCases)
      .set({ messagesSent: sql`${recoveryCases.messagesSent} + 1`, updatedAt: sql`now()` })
      .where(eq(recoveryCases.id, caseId));
  }

  await db
    .update(recoveryCases)
    .set({ currentRung: rungIndex, updatedAt: sql`now()` })
    .where(eq(recoveryCases.id, caseId));

  await appendEvent(db, {
    caseId,
    merchantId,
    kind: 'rung_fired',
    actor: 'workflow',
    payload: {
      rung: rungIndex,
      at: rung.at,
      action: action.kind,
      channel,
      suppressedReason,
      ...(action.kind === 'nudge' ? { intent: action.intent, suggest: action.suggest } : {}),
    },
  });

  return {
    disposition: 'suppressed',
    gate,
    suppressedReason,
    action,
    channel,
    retryAt: null,
    note: `planned and recorded; not sent (${suppressedReason})`,
  };
}

/**
 * Turn a policy rung into a typed action from the allowlist.
 *
 * The planner may only emit a value of this union — it never gets a generic
 * handle on the Razorpay API. Bounded autonomy as a type rather than as a
 * promise.
 */
function buildAction(input: ExecuteRungInput): { action: Action; channel: string | null } | null {
  const { rung, rungIndex, gathered, diagnosisRails, sameInstrumentRetry } = input;

  switch (rung.action) {
    case 'nudge': {
      const channel = selectChannel(rung.channels, gathered.facts.eligibleChannels);
      if (!channel) return null;

      // The live diagnosis may only ever REMOVE rails the static table offered.
      // A policy can never re-authorise something the diagnosis has ruled out —
      // e.g. `retry_same` after a third failed OTP.
      const rails = effectiveRails(rung.suggest, {
        suggestedRails: diagnosisRails,
        sameInstrumentRetry,
      } as Diagnosis);

      return {
        action: {
          kind: 'nudge',
          rung: rungIndex,
          channels: [channel],
          intent: rung.intent,
          suggest: rails,
          attachPaymentLink: rung.attachPaymentLink,
        },
        channel,
      };
    }

    case 'send_pre_debit_notice': {
      const channel = selectChannel(rung.channels, gathered.facts.eligibleChannels);
      if (!channel) return null;
      return {
        action: {
          kind: 'send_pre_debit_notice',
          rung: rungIndex,
          mandateId: 'pending',
          amount: 0 as never,
          debitAt: gathered.facts.now,
          channels: [channel],
        },
        channel,
      };
    }

    case 'retry_debit':
      return {
        action: {
          kind: 'retry_debit',
          rung: rungIndex,
          mandateId: 'pending',
          amount: 0 as never,
        },
        channel: null,
      };

    case 'await_downtime_resolution':
      return {
        action: {
          kind: 'await_downtime_resolution',
          rung: rungIndex,
          bank: null,
          method: 'unknown',
          timeoutMinutes: 240,
        },
        channel: null,
      };

    case 'merchant_alert':
      return {
        action: {
          kind: 'merchant_alert',
          rung: rungIndex,
          severity: rung.severity,
          signal: 'ladder',
          affectedCases: rung.minAffectedCases,
          amountAtRisk: 0 as never,
          onsetAt: gathered.facts.now,
        },
        channel: null,
      };

    case 'escalate_to_human':
      return {
        action: {
          kind: 'escalate_to_human',
          rung: rungIndex,
          queue: rung.queue,
          note: rung.note ?? 'escalated by ladder',
        },
        channel: null,
      };

    default:
      return null;
  }
}
