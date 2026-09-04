/**
 * The send path.
 *
 * The ONLY way a message reaches a customer. Everything upstream — the ladder,
 * the gate, composition — converges here, and everything that could go wrong at
 * a provider is classified here.
 *
 * Three things this function guarantees, and the reasons they are guarantees
 * rather than conventions:
 *
 * 1. **The frequency lock is taken before the provider call, not after.**
 *    `recordMessageIfPermitted` claims the slot under a customer-scoped advisory
 *    lock. Sending first and recording after would let two concurrent ladders
 *    both send and both then discover the cap.
 *
 * 2. **A failed send releases nothing.** The ledger row stays, marked failed.
 *    The alternative — deleting it so the customer "gets their slot back" —
 *    means a provider hiccup turns into two messages for one rung.
 *
 * 3. **A permanent channel failure marks the channel dead.** An undeliverable
 *    WhatsApp number sets `phoneUndeliverableAt`, which `gatherFacts` reads, so
 *    the next rung falls through to email instead of failing identically.
 */

import { eq, sql } from 'drizzle-orm';

import type { Channel } from '../core/actions/types.js';
import type { Database } from '../db/client.js';
import { customers } from '../db/schema/customers.js';
import { messageLog } from '../db/schema/messaging.js';
import {
  markMessageFailed,
  markMessageSent,
  recordMessageIfPermitted,
} from '../db/repos/messages.js';
import { markUndeliverable } from '../db/repos/customers.js';
import type { WhatsAppClient } from '../adapters/whatsapp/client.js';
import type { EmailClient } from '../adapters/email/resend.js';
import { emailSubject } from './compose.js';
import type { ComposedMessage } from './compose.js';

export interface SendChannels {
  whatsapp?: WhatsAppClient;
  email?: EmailClient;
}

export interface SendInput {
  db: Database;
  merchantId: string;
  customerId: string;
  /** Null for a touch that has no case at all — the abandoned-cart agent. */
  caseId: string | null;
  rung: number;
  channel: Channel;
  message: ComposedMessage;
  merchantName: string;
  /** E.164. */
  phone: string | null;
  email: string | null;
  frequencyCap: number;
  idempotencyKey: string;
  /**
   * Set to skip the provider entirely while still writing the ledger row —
   * holdout and dry-run. The row is what makes the two cohorts comparable.
   */
  suppressedReason: string | null;
  channels: SendChannels;
}

export type SendOutcome =
  | { status: 'sent'; messageId: string; providerMessageId: string }
  | { status: 'suppressed'; messageId: string; reason: string }
  | { status: 'refused'; reason: 'frequency_cap' | 'opted_out' | 'duplicate' }
  | { status: 'failed'; messageId: string | null; failure: string; detail: string; retryable: boolean }
  | { status: 'no_channel'; detail: string };

export async function sendMessage(input: SendInput): Promise<SendOutcome> {
  const { db } = input;

  // 1 ── Claim the slot. Under the customer advisory lock, so two ladders for
  //      the same person cannot both decide there is room.
  const claim = await recordMessageIfPermitted(
    db,
    {
      merchantId: input.merchantId,
      customerId: input.customerId,
      caseId: input.caseId,
      rung: input.rung,
      channel: input.channel as 'whatsapp' | 'sms' | 'email' | 'in_app',
      intent: input.message.intent,
      idempotencyKey: input.idempotencyKey,
      templateId: input.message.templateName,
      locale: input.message.language,
      body: input.message.preview,
      suppressedReason: input.suppressedReason,
    },
    input.frequencyCap,
  );

  if (!claim.permitted) {
    return { status: 'refused', reason: claim.reason };
  }

  const messageId = claim.messageId;

  // 2 ── Holdout and dry-run stop here: fully planned, deliberately not sent.
  if (input.suppressedReason) {
    return { status: 'suppressed', messageId, reason: input.suppressedReason };
  }

  // 3 ── Hand to the provider.
  const result = await dispatch(input);

  if (result.kind === 'no_channel') {
    await markMessageFailed(db, messageId, result.detail);
    return { status: 'no_channel', detail: result.detail };
  }

  if (result.ok) {
    await markMessageSent(db, messageId, result.providerMessageId);
    return { status: 'sent', messageId, providerMessageId: result.providerMessageId };
  }

  await markMessageFailed(db, messageId, `${result.failure}: ${result.detail}`);

  // A permanently undeliverable address is a fact about the customer, not about
  // this message. Recording it lets the next rung pick a different channel
  // instead of failing the same way.
  if (!result.retryable && isPermanentAddressFailure(result.failure)) {
    await markUndeliverable(db, input.customerId, input.channel === 'email' ? 'email' : 'phone');
  }

  return {
    status: 'failed',
    messageId,
    failure: result.failure,
    detail: result.detail,
    retryable: result.retryable,
  };
}

function isPermanentAddressFailure(failure: string): boolean {
  return failure === 'undeliverable' || failure === 'invalid_recipient';
}

type DispatchResult =
  | { kind: 'result'; ok: true; providerMessageId: string }
  | { kind: 'result'; ok: false; failure: string; detail: string; retryable: boolean }
  | { kind: 'no_channel'; detail: string };

async function dispatch(input: SendInput): Promise<DispatchResult> {
  if (input.channel === 'whatsapp') {
    if (!input.channels.whatsapp) {
      return { kind: 'no_channel', detail: 'WhatsApp client not configured' };
    }
    if (!input.phone) return { kind: 'no_channel', detail: 'no phone number on file' };

    const r = await input.channels.whatsapp.sendTemplate({
      to: input.phone,
      templateName: input.message.templateName,
      language: input.message.language,
      variables: input.message.variables,
    });

    return r.ok && r.messageId
      ? { kind: 'result', ok: true, providerMessageId: r.messageId }
      : {
          kind: 'result',
          ok: false,
          failure: r.failure ?? 'unknown',
          detail: r.detail ?? 'send failed',
          retryable: r.retryable,
        };
  }

  if (input.channel === 'email') {
    if (!input.channels.email) {
      return { kind: 'no_channel', detail: 'email client not configured' };
    }
    if (!input.email) return { kind: 'no_channel', detail: 'no email address on file' };

    const r = await input.channels.email.send({
      to: input.email,
      subject: emailSubject(input.message.intent, input.merchantName),
      // Email has no template concept, so the rendered preview IS the body.
      // Same words as WhatsApp, one source.
      text: input.message.preview,
    });

    return r.ok && r.messageId
      ? { kind: 'result', ok: true, providerMessageId: r.messageId }
      : {
          kind: 'result',
          ok: false,
          failure: r.failure ?? 'unknown',
          detail: r.detail ?? 'send failed',
          retryable: r.retryable,
        };
  }

  // Unreachable from a ladder: `SENDABLE_CHANNELS` is what the policy schema
  // validates against, so no compiled rung can name `sms` or `in_app` any more.
  // Kept because `Channel` is still the full vocabulary — `message_log` holds
  // historical rows naming these — and because a caller outside the policy path
  // could pass one. Reported honestly rather than silently dropped.
  return { kind: 'no_channel', detail: `channel '${input.channel}' is not implemented yet` };
}

/** Delivery receipt from a provider webhook. */
export async function recordDeliveryStatus(
  db: Database,
  providerMessageId: string,
  status: 'delivered' | 'read' | 'failed',
  detail?: string,
): Promise<{ matched: boolean }> {
  const updated = await db
    .update(messageLog)
    .set({
      status,
      ...(status === 'delivered' || status === 'read' ? { deliveredAt: sql`now()` } : {}),
      ...(status === 'failed' && detail ? { error: detail.slice(0, 2000) } : {}),
    })
    .where(eq(messageLog.providerMessageId, providerMessageId))
    .returning({ id: messageLog.id });

  return { matched: updated.length > 0 };
}

/**
 * A customer replied STOP.
 *
 * Global and permanent: the gate aborts on `optedOutAt` for every case, present
 * and future. Not scoped to the case they replied to — someone who says stop
 * means stop, and honouring it narrowly is the same as not honouring it.
 */
export async function optOutByPhone(
  db: Database,
  phone: string,
  reason = 'replied STOP',
): Promise<{ optedOut: number }> {
  const updated = await db
    .update(customers)
    .set({ optedOutAt: sql`now()`, optOutReason: reason, updatedAt: sql`now()` })
    .where(sql`${customers.phone} = ${phone} and ${customers.optedOutAt} is null`)
    .returning({ id: customers.id });

  return { optedOut: updated.length };
}
