/**
 * Rung execution.
 *
 * One function, `executeRung`, called once per ladder step. It is the only
 * place in the system where an action becomes a real thing in the world, which
 * is why every guard converges here rather than being scattered across the
 * workflow.
 *
 * Messages are real from Stage 7 on. Two reasons a rung still does not send,
 * and they are NOT the same thing:
 *
 *   holdout    a real control group. Runs the identical ladder through the
 *              identical gate, sends nothing, and is the only honest way to
 *              know what the treatment was worth.
 *   dry_run    the merchant has not turned execution on yet.
 *
 * Collapsing them would make the incrementality report meaningless: a dry-run
 * case is not a control, it is a case nobody was ever treated in.
 */

import { eq, sql } from 'drizzle-orm';

import { type Action, type Channel, idempotencyKey } from '../core/actions/types.js';
import { effectiveRails } from '../core/policy/resolve.js';
import { evaluatePreconditions, selectChannel } from '../core/guards/preconditions.js';
import type { GateResult } from '../core/guards/preconditions.js';
import type { LadderRung, PolicyRow } from '../core/policy/schema.js';
import type { Diagnosis } from '../core/taxonomy/diagnose.js';
import type { AlternateRail } from '../core/case/types.js';

import type { Database } from '../db/client.js';
import { caseActions, recoveryCases } from '../db/schema/cases.js';
import { appendEvent } from '../db/repos/cases.js';
import type { Paise } from '../core/money.js';
import { compose } from '../messaging/compose.js';
import { sendMessage, type SendChannels, type SendOutcome } from '../messaging/send.js';
import { channelsForMerchant } from './merchant-clients.js';
import { ensurePaymentLink } from './payment-link.js';
import type { RazorpayClient } from '../adapters/razorpay/client.js';
import type { GatheredFacts } from './facts.js';

export type SuppressionReason = 'holdout' | 'dry_run';

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
  /** Injected by tests; production resolves from the merchant. */
  channels?: SendChannels;
  /**
   * The merchant's own Razorpay client, resolved by the caller.
   *
   * Deliberately NOT resolved here from a fallback. Omitting it means "do not
   * create a payment link", and it has to keep meaning exactly that: an
   * omitted credential that quietly becomes whatever key is in the environment
   * is how a link gets created on the wrong merchant's account and takes a real
   * customer to a checkout billing the wrong business.
   */
  razorpay?: RazorpayClient;
}

export interface RungOutcome {
  disposition: 'executed' | 'suppressed' | 'skipped' | 'deferred' | 'aborted';
  gate: GateResult;
  suppressedReason: SuppressionReason | null;
  action: Action | null;
  channel: Channel | null;
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
  const suppressedReason: SuppressionReason | null =
    cohort === 'holdout' ? 'holdout' : gathered.dryRun ? 'dry_run' : null;

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
      status: suppressedReason ? 'suppressed' : 'executed',
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

  // ── compose and send ──
  //
  // Composition is pure and can refuse: no approved template for the intent, or
  // no payment link where the copy needs one. A refusal is a SKIP, never a
  // partial send — "Pay here: " with nothing after it is worse than silence.
  let sendOutcome: SendOutcome | null = null;

  if (channel && (action.kind === 'nudge' || action.kind === 'send_pre_debit_notice')) {
    if (!gathered.customerId) {
      return {
        disposition: 'skipped',
        gate,
        suppressedReason,
        action,
        channel,
        retryAt: null,
        note: 'no customer record to message',
      };
    }

    // Create the link lazily, on the first rung that needs one. Most cases
    // never reach a rung, so creating one per failure would litter the
    // merchant dashboard with links nobody opens.
    let paymentLinkUrl = gathered.paymentLinkUrl;
    const needsLink = action.kind === 'nudge' && action.attachPaymentLink;

    if (needsLink && !paymentLinkUrl && input.razorpay) {
      const link = await ensurePaymentLink({
        db,
        razorpay: input.razorpay,
        caseId,
        merchantId,
        merchantName: gathered.merchantName,
        amountPaise: gathered.amountPaise,
        customerName: gathered.customerName,
        customerPhone: gathered.customerPhone,
        customerEmail: gathered.customerEmail,
        expiresAt: gathered.facts.deadlinePassed ? null : null,
        now: gathered.facts.now,
      });
      if (link.ok) paymentLinkUrl = link.url;
    }

    const composed = compose({
      intent: action.kind === 'nudge' ? action.intent : 'pre_debit_notice',
      locale: gathered.customerLocale,
      customerName: gathered.customerName,
      merchantName: gathered.merchantName,
      amountPaise: gathered.amountPaise as Paise,
      paymentLink: paymentLinkUrl,
      debitAt: action.kind === 'send_pre_debit_notice' ? action.debitAt : null,
    });

    if (!composed.ok) {
      await appendEvent(db, {
        caseId,
        merchantId,
        kind: 'rung_uncomposable',
        reason: composed.reason,
        actor: 'workflow',
        payload: { rung: rungIndex, detail: composed.detail },
      });
      return {
        disposition: 'skipped',
        gate,
        suppressedReason,
        action,
        channel,
        retryAt: null,
        note: `could not compose: ${composed.detail}`,
      };
    }

    // One path for treatment and holdout alike. The suppressed reason decides
    // whether the provider is called; everything before that is identical, so
    // the two cohorts stay comparable.
    sendOutcome = await sendMessage({
      db,
      merchantId,
      customerId: gathered.customerId,
      caseId,
      rung: rungIndex,
      channel,
      message: composed.message,
      merchantName: gathered.merchantName,
      phone: gathered.customerPhone,
      email: gathered.customerEmail,
      frequencyCap: gathered.facts.frequencyCap,
      idempotencyKey: key,
      suppressedReason,
      // Resolved from the merchant, not from global env: the routing that
      // decides whether this reaches the customer or a test inbox is a property
      // of the merchant this case belongs to.
      channels: input.channels ?? (await channelsForMerchant(db, merchantId)),
    });

    if (sendOutcome.status === 'refused') {
      return {
        disposition: 'skipped',
        gate,
        suppressedReason,
        action,
        channel,
        retryAt: null,
        note: `message ledger refused: ${sendOutcome.reason}`,
      };
    }

    if (sendOutcome.status === 'no_channel') {
      return {
        disposition: 'skipped',
        gate,
        suppressedReason,
        action,
        channel,
        retryAt: null,
        note: sendOutcome.detail,
      };
    }

    // A failed send still counted against the cap — the ledger row stays. The
    // alternative, releasing the slot, turns one provider hiccup into two
    // messages for one rung.
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

  // `suppressed` and `executed` are genuinely different outcomes and the
  // caller acts on them differently — the dry-run report counts one, the
  // incrementality ledger counts the other. Reporting a real send as
  // "suppressed (null)" made a working send look like a bug.
  if (suppressedReason) {
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

  const note =
    sendOutcome?.status === 'failed'
      ? `send failed: ${sendOutcome.failure} — ${sendOutcome.detail}`
      : channel
        ? `sent via ${channel}`
        : 'executed';

  return {
    disposition: 'executed',
    gate,
    suppressedReason: null,
    action,
    channel,
    retryAt: null,
    note,
  };
}

/**
 * Turn a policy rung into a typed action from the allowlist.
 *
 * The planner may only emit a value of this union — it never gets a generic
 * handle on the Razorpay API. Bounded autonomy as a type rather than as a
 * promise.
 */
function buildAction(input: ExecuteRungInput): { action: Action; channel: Channel | null } | null {
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
