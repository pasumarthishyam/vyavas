/**
 * The frequency cap.
 *
 * `recordMessageIfPermitted` is the only sanctioned way to send. It counts and
 * writes inside a single customer-locked transaction, so the check and the
 * write cannot interleave with a concurrent workflow's.
 *
 * Doing this in two steps — count, decide, then send — is the bug this function
 * exists to prevent: two workflows both read "1 message today, cap is 2", both
 * decide there is room, and the person gets three.
 */

import { and, count, eq, gt, isNull, notInArray, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { messageLog } from '../schema/messaging.js';
import { customers } from '../schema/customers.js';
import { withCustomerLock } from './locks.js';

/**
 * Intents that are real sends — not holdout, not suppressed — but that do not
 * draw on the ladder's daily frequency budget.
 *
 * `call_follow_up` (the discount-caller agent's payment-link email) is the
 * first of these: it is a follow-up to a call the customer was just ON, not
 * an unprompted outbound touch, and it must never be able to eat the budget a
 * failed-payment case needs, or be blocked by a cap that has nothing to do
 * with it. Same reasoning as the `suppressedReason` exemption just below, for
 * a different situation — that one is "nothing was sent," this one is "it was
 * sent, but it isn't the kind of touch the cap exists to limit."
 */
const CAP_EXEMPT_INTENTS = ['call_follow_up'] as const;

export interface RecordMessageInput {
  merchantId: string;
  customerId: string;
  caseId: string | null;
  rung: number;
  channel: 'whatsapp' | 'sms' | 'email' | 'in_app';
  intent: string;
  idempotencyKey: string;
  templateId?: string | null;
  locale?: string | null;
  body?: string | null;
  /** Set for holdout / dry-run: fully planned, deliberately not sent. */
  suppressedReason?: string | null;
}

export type SendDecision =
  | { permitted: true; messageId: string }
  | {
      permitted: false;
      reason: 'frequency_cap' | 'opted_out' | 'duplicate';
      recentCount?: number;
    };

/** Real (unsuppressed) touches this customer has had in the last `hours`. */
export async function countRecentMessages(
  db: Database,
  customerId: string,
  hours = 24,
): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(messageLog)
    .where(
      and(
        eq(messageLog.customerId, customerId),
        // Suppressed rows are holdout/dry-run records. They must not consume a
        // real customer's budget, or the holdout would suppress treatment too.
        isNull(messageLog.suppressedReason),
        notInArray(messageLog.intent, [...CAP_EXEMPT_INTENTS]),
        gt(messageLog.sentAt, sql`now() - make_interval(hours => ${hours})`),
      ),
    );
  return rows.at(0)?.n ?? 0;
}

/**
 * Count, decide and write under one lock.
 *
 * A suppressed message (holdout, dry-run) still writes a row — that record is
 * what makes the incrementality comparison possible — but it is exempt from the
 * cap, because nothing reached the customer.
 */
export async function recordMessageIfPermitted(
  db: Database,
  input: RecordMessageInput,
  cap: number,
): Promise<SendDecision> {
  return withCustomerLock(db, input.customerId, async (tx) => {
    const [customer] = await tx
      .select({ optedOutAt: customers.optedOutAt })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);

    if (customer?.optedOutAt != null) {
      return { permitted: false, reason: 'opted_out' } as const;
    }

    const isSuppressed = input.suppressedReason != null;
    const isCapExempt = (CAP_EXEMPT_INTENTS as readonly string[]).includes(input.intent);

    if (!isSuppressed && !isCapExempt) {
      const recent = await countRecentMessages(tx, input.customerId, 24);
      if (recent >= cap) {
        return { permitted: false, reason: 'frequency_cap', recentCount: recent } as const;
      }
    }

    const inserted = await tx
      .insert(messageLog)
      .values({
        merchantId: input.merchantId,
        customerId: input.customerId,
        caseId: input.caseId,
        rung: input.rung,
        channel: input.channel,
        intent: input.intent,
        idempotencyKey: input.idempotencyKey,
        templateId: input.templateId ?? null,
        locale: input.locale ?? null,
        body: input.body ?? null,
        suppressedReason: input.suppressedReason ?? null,
        status: isSuppressed ? 'suppressed' : 'queued',
      })
      .onConflictDoNothing({ target: messageLog.idempotencyKey })
      .returning({ id: messageLog.id });

    const row = inserted.at(0);
    // Lost the idempotency race — a replay of the same rung. Not an error.
    if (!row) return { permitted: false, reason: 'duplicate' } as const;

    return { permitted: true, messageId: row.id } as const;
  });
}

export async function markMessageSent(
  db: Database,
  messageId: string,
  providerMessageId: string,
): Promise<void> {
  await db
    .update(messageLog)
    .set({ status: 'sent', providerMessageId })
    .where(eq(messageLog.id, messageId));
}

export async function markMessageFailed(
  db: Database,
  messageId: string,
  error: string,
): Promise<void> {
  await db
    .update(messageLog)
    .set({ status: 'failed', error: error.slice(0, 2000) })
    .where(eq(messageLog.id, messageId));
}
