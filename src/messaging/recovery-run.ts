/**
 * Manual recovery, driven from the console.
 *
 * The ladder in `run-ladder.ts` is the real thing: durable, sleeping hours
 * between rungs, cancelled by a payment. This is its hand-operated twin — one
 * case, started by a click, with the two channels seconds apart so a human can
 * watch the whole arc.
 *
 * What is REAL here: the gate, composition, the frequency lock, the templates,
 * the sends, the ledger. Every message goes through `sendMessage`, the same
 * single path the ladder uses.
 *
 * What is COMPRESSED: only the timing. WhatsApp now, email 30 seconds later,
 * instead of 4 minutes and 26 hours.
 *
 * The follow-up is stored as a scheduled `case_action` rather than a timer.
 * A `setTimeout` in a serverless request dies with the request, and a promise
 * kept alive across an HTTP response is a message that may or may not exist
 * depending on whether the process survived. A row is durable and observable —
 * the console can show it as pending, and firing it twice is prevented by the
 * same idempotency key everything else uses.
 */

import { and, eq, isNull, lte, sql } from 'drizzle-orm';

import type { Channel, MessageIntent } from '../core/actions/types.js';
import { evaluatePreconditions, selectChannel } from '../core/guards/preconditions.js';
import { resolvePolicy, matchInputFrom } from '../core/policy/resolve.js';
import { POLICY_TABLE } from '../core/policy/index.js';
import type { Paise } from '../core/money.js';

import type { Database } from '../db/client.js';
import { caseActions, recoveryCases } from '../db/schema/cases.js';
import { appendEvent } from '../db/repos/cases.js';
import { gatherFacts } from '../workflows/facts.js';
import { channelsForMerchant, razorpayForMerchant } from '../workflows/merchant-clients.js';
import { ensurePaymentLink } from '../workflows/payment-link.js';
import { compose } from './compose.js';
import { sendMessage, type SendOutcome } from './send.js';

/** Seconds between the WhatsApp message and the email follow-up. */
export const FOLLOW_UP_SECONDS = 30;

export interface StepResult {
  channel: Channel;
  intent: MessageIntent;
  status: 'sent' | 'suppressed' | 'skipped' | 'failed' | 'blocked';
  detail: string;
  providerMessageId?: string | null;
}

export interface StartResult {
  ok: boolean;
  caseId: string;
  steps: StepResult[];
  followUpAt: string | null;
  reason?: string;
}

/**
 * The intent for this case.
 *
 * Taken from the first nudge of the ladder the case was STAMPED with, so the
 * console says exactly what the real ladder would have said — a card that is
 * not enrolled for online payments gets the educational message, not a generic
 * "your payment failed".
 */
function intentFor(policyId: string | null): MessageIntent {
  const policy = POLICY_TABLE.find((p) => p.id === policyId);
  const nudge = policy?.ladder.find((r) => r.action === 'nudge');
  return nudge?.action === 'nudge' ? nudge.intent : 'switch_method';
}

export async function startRecovery(db: Database, caseId: string): Promise<StartResult> {
  const now = new Date();
  const gathered = await gatherFacts({ db, caseId, now });
  if (!gathered) return { ok: false, caseId, steps: [], followUpAt: null, reason: 'case not found' };

  const [row] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseId)).limit(1);
  if (!row) return { ok: false, caseId, steps: [], followUpAt: null, reason: 'case not found' };

  // Resolve the ladder so the gate uses the real preconditions, not a guess.
  const resolved = resolvePolicy(
    POLICY_TABLE,
    matchInputFrom(
      {
        errorCode: row.errorCode,
        errorSource: row.errorSource,
        errorStep: row.errorStep,
        errorReason: row.errorReason,
        method: row.method,
        bank: row.bank,
        network: row.network,
      },
      {
        causeClass: (row.causeClass ?? 'transient_infra') as never,
        caseType: row.type,
        attended: row.attended,
        suggestedRails: [],
        sameInstrumentRetry: false,
      } as never,
      row.amountAtRiskPaise as Paise,
    ),
  );

  const gate = evaluatePreconditions(resolved.row.preconditions, gathered.facts);
  if (gate.disposition !== 'proceed') {
    return {
      ok: false,
      caseId,
      steps: [{ channel: 'whatsapp', intent: 'switch_method', status: 'blocked', detail: gate.reason }],
      followUpAt: null,
      reason: gate.reason,
    };
  }

  const intent = intentFor(row.policyId);

  // A link is needed before anything can be composed — the copy refuses to
  // render with a blank where the link goes.
  let link = gathered.paymentLinkUrl;
  if (!link) {
    // This merchant's own Razorpay account. Refused rather than falling back to
    // env: a link created on the wrong account bills the wrong business.
    const rzp = await razorpayForMerchant(db, row.merchantId);
    if (!rzp) {
      return {
        ok: false,
        caseId,
        steps: [],
        followUpAt: null,
        reason: 'no Razorpay credentials stored for this merchant — run npm run merchant:connect',
      };
    }

    const made = await ensurePaymentLink({
      db,
      razorpay: rzp,
      caseId,
      merchantId: row.merchantId,
      merchantName: gathered.merchantName,
      amountPaise: gathered.amountPaise,
      customerName: gathered.customerName,
      customerPhone: gathered.customerPhone,
      customerEmail: gathered.customerEmail,
      expiresAt: row.deadlineAt,
      now,
    });
    if (!made.ok) {
      return { ok: false, caseId, steps: [], followUpAt: null, reason: `payment link: ${made.reason}` };
    }
    link = made.url;
  }

  await db
    .update(recoveryCases)
    .set({ state: 'executing', updatedAt: sql`now()` })
    .where(and(eq(recoveryCases.id, caseId), eq(recoveryCases.state, 'diagnosed')));

  // ── WhatsApp, now ──
  const whatsapp = await deliver(db, {
    caseId,
    merchantId: row.merchantId,
    gathered,
    intent,
    link,
    channel: 'whatsapp',
    rung: 0,
  });

  // ── Email, scheduled ──
  const followUpAt = new Date(now.getTime() + FOLLOW_UP_SECONDS * 1000);
  let scheduled = false;

  if (gathered.customerEmail) {
    const inserted = await db
      .insert(caseActions)
      .values({
        caseId,
        merchantId: row.merchantId,
        rung: 1,
        kind: 'nudge',
        status: 'planned',
        idempotencyKey: `${caseId}:1:nudge`,
        params: { channel: 'email', intent, link } as never,
        scheduledFor: followUpAt,
      })
      .onConflictDoNothing({ target: caseActions.idempotencyKey })
      .returning({ id: caseActions.id });
    scheduled = inserted.length > 0;
  }

  await appendEvent(db, {
    caseId,
    merchantId: row.merchantId,
    kind: 'recovery_started',
    actor: 'console',
    payload: { intent, whatsapp: whatsapp.status, followUpAt: scheduled ? followUpAt.toISOString() : null },
  });

  /*
   * "Nothing happened" must never look like success.
   *
   * This used to return `ok: true` whatever the step did, so a WhatsApp the
   * ledger had refused came back as HTTP 200 with no error — the console showed
   * no banner, no message, no change, and the only honest record was a
   * `recovery_started` payload reading `whatsapp: "blocked"` that nothing
   * rendered. Three clicks in a row produced three of those and looked, from
   * the outside, like a button that did nothing at all.
   *
   * A dry run counts as success: it is supposed to send nothing, and it wrote
   * the ledger row that proves what it would have said.
   */
  const didSomething =
    whatsapp.status === 'sent' || whatsapp.status === 'suppressed' || scheduled;

  return {
    ok: didSomething,
    caseId,
    steps: [whatsapp],
    followUpAt: scheduled ? followUpAt.toISOString() : null,
    ...(didSomething ? {} : { reason: `${whatsapp.channel}: ${whatsapp.detail}` }),
  };
}

/**
 * Fire any follow-up whose time has come.
 *
 * Called by the console's status poll. That makes the console the scheduler,
 * which is honest for a test surface and stated plainly: close the page and the
 * follow-up waits rather than firing. The real ladder uses Inngest, which does
 * not care whether anyone is watching.
 */
export async function fireDueFollowUps(
  db: Database,
  merchantId: string,
): Promise<StepResult[]> {
  const due = await db
    .select()
    .from(caseActions)
    .where(
      and(
        eq(caseActions.merchantId, merchantId),
        eq(caseActions.status, 'planned'),
        isNull(caseActions.executedAt),
        lte(caseActions.scheduledFor, sql`now()`),
      ),
    )
    .limit(5);

  const results: StepResult[] = [];

  for (const action of due) {
    const params = (action.params ?? {}) as { channel?: string; intent?: string; link?: string };
    const gathered = await gatherFacts({ db, caseId: action.caseId, now: new Date() });

    // Claim it first. A second poll arriving while this one is mid-send must
    // not produce a second email.
    const claimed = await db
      .update(caseActions)
      .set({ executedAt: sql`now()` })
      .where(and(eq(caseActions.id, action.id), isNull(caseActions.executedAt)))
      .returning({ id: caseActions.id });
    if (claimed.length === 0) continue;

    if (!gathered) {
      await db.update(caseActions).set({ status: 'skipped' }).where(eq(caseActions.id, action.id));
      continue;
    }

    const [row] = await db
      .select()
      .from(recoveryCases)
      .where(eq(recoveryCases.id, action.caseId))
      .limit(1);
    if (!row) continue;

    const resolved = POLICY_TABLE.find((p) => p.id === row.policyId);
    const gate = evaluatePreconditions(resolved?.preconditions ?? [], gathered.facts);

    /*
     * A DEFER is not a skip, and collapsing the two is what made the follow-up
     * email impossible to send.
     *
     * Both dispositions used to land here and both were written as `skipped` —
     * terminal, with the claim already taken, so nothing ever looked at the row
     * again. The gate says "not yet, ask again at X"; the row said "never".
     *
     * It was not a rare edge either. The console schedules this email 30
     * SECONDS after the WhatsApp, and the cool-off floor is a merchant setting
     * measured in minutes, so the very first check was guaranteed to defer and
     * guaranteed to be recorded as a permanent skip. The email could not send
     * on any case, ever, and the only trace was one `skip_reason` nobody was
     * shown.
     *
     * So: an abort is terminal and stays terminal. A defer releases the claim
     * and moves `scheduled_for` to the instant the gate named, and the next
     * poll past that instant picks it up. Releasing the claim is safe precisely
     * because a deferred rung has sent nothing.
     */
    if (gate.disposition === 'defer' && gate.retryAt) {
      await db
        .update(caseActions)
        .set({ executedAt: null, scheduledFor: gate.retryAt, skipReason: gate.reason })
        .where(eq(caseActions.id, action.id));
      results.push({
        channel: 'email',
        intent: (params.intent ?? 'switch_method') as MessageIntent,
        status: 'skipped',
        detail: `${gate.reason} — rescheduled for ${gate.retryAt.toISOString()}`,
      });
      continue;
    }

    if (gate.disposition !== 'proceed') {
      await db
        .update(caseActions)
        .set({ status: 'skipped', skipReason: gate.reason })
        .where(eq(caseActions.id, action.id));
      results.push({
        channel: 'email',
        intent: (params.intent ?? 'switch_method') as MessageIntent,
        status: 'blocked',
        detail: gate.reason,
      });
      continue;
    }

    const step = await deliver(db, {
      caseId: action.caseId,
      merchantId,
      gathered,
      intent: (params.intent ?? 'switch_method') as MessageIntent,
      link: params.link ?? gathered.paymentLinkUrl,
      channel: 'email',
      rung: 1,
    });

    await db
      .update(caseActions)
      .set({ status: step.status === 'sent' ? 'executed' : 'failed', result: step as never })
      .where(eq(caseActions.id, action.id));

    results.push(step);
  }

  return results;
}

// ─── one delivery ────────────────────────────────────────────────────────────

interface DeliverInput {
  caseId: string;
  merchantId: string;
  gathered: NonNullable<Awaited<ReturnType<typeof gatherFacts>>>;
  intent: MessageIntent;
  link: string | null;
  channel: Channel;
  rung: number;
}

/** Turn a one-word ledger refusal into something a person can act on. */
function refusalDetail(reason: 'frequency_cap' | 'opted_out' | 'duplicate', channel: Channel): string {
  switch (reason) {
    case 'duplicate':
      return (
        `this case has already had its ${channel} message — the ledger refuses a second one ` +
        `under the same key. Trigger a fresh failed payment to test again; re-clicking Start ` +
        `on a case that already sent can never send twice.`
      );
    case 'frequency_cap':
      return 'this customer has had their maximum messages for the day across all cases';
    case 'opted_out':
      return 'this customer has opted out';
  }
}

async function deliver(db: Database, input: DeliverInput): Promise<StepResult> {
  const { gathered, intent, channel } = input;

  const chosen = selectChannel([channel], gathered.facts.eligibleChannels);
  if (!chosen) {
    return {
      channel,
      intent,
      status: 'skipped',
      detail: `no consented, deliverable ${channel} for this customer`,
    };
  }

  const composed = compose({
    intent,
    locale: gathered.customerLocale,
    customerName: gathered.customerName,
    merchantName: gathered.merchantName,
    amountPaise: gathered.amountPaise as Paise,
    paymentLink: input.link,
  });

  if (!composed.ok) {
    return { channel, intent, status: 'skipped', detail: composed.detail };
  }

  if (!gathered.customerId) {
    return { channel, intent, status: 'skipped', detail: 'no customer record' };
  }

  const outcome: SendOutcome = await sendMessage({
    db,
    merchantId: input.merchantId,
    customerId: gathered.customerId,
    caseId: input.caseId,
    rung: input.rung,
    channel: chosen,
    message: composed.message,
    merchantName: gathered.merchantName,
    phone: gathered.customerPhone,
    email: gathered.customerEmail,
    frequencyCap: gathered.facts.frequencyCap,
    idempotencyKey: `${input.caseId}:${input.rung}:${chosen}`,
    // Holdout and dry-run still suppress. The console can start a recovery;
    // it cannot override the merchant's own switch.
    suppressedReason: gathered.dryRun ? 'dry_run' : null,
    channels: await channelsForMerchant(db, input.merchantId),
  });

  switch (outcome.status) {
    case 'sent':
      // The ladder path does this in `executeRung`; this one did not, so a
      // console-driven recovery left the case reading `messagesSent: 0` after
      // two real sends. That is not merely a wrong number on a card — the gate
      // reads it, and a counter that never moves makes every rung look like a
      // first touch forever.
      await db
        .update(recoveryCases)
        .set({ messagesSent: sql`${recoveryCases.messagesSent} + 1`, updatedAt: sql`now()` })
        .where(eq(recoveryCases.id, input.caseId));

      return {
        channel: chosen,
        intent,
        status: 'sent',
        detail: `delivered to ${chosen}`,
        providerMessageId: outcome.providerMessageId,
      };
    case 'suppressed':
      return { channel: chosen, intent, status: 'suppressed', detail: outcome.reason };
    case 'refused':
      // The ledger's refusals are single words, and one of them accounts for
      // every "I clicked Start and nothing happened": a case whose rung has
      // already been sent is refused as a `duplicate` forever, which is correct
      // and completely opaque. Say what it means and what to do instead.
      return { channel: chosen, intent, status: 'blocked', detail: refusalDetail(outcome.reason, chosen) };
    case 'no_channel':
      return { channel: chosen, intent, status: 'skipped', detail: outcome.detail };
    default:
      return {
        channel: chosen,
        intent,
        status: 'failed',
        detail: `${outcome.failure}: ${outcome.detail}`,
      };
  }
}
