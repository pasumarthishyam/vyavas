/**
 * The payment link.
 *
 * Created lazily — on the first rung that actually needs one, not at diagnosis.
 * Most cases never reach a rung: they get paid, aborted, or gated out. Creating
 * a link for every failure would mean thousands of unused links cluttering the
 * merchant's Razorpay dashboard and thousands of pointless API calls.
 *
 * Idempotent by the stored id. One live link per case, forever — a second link
 * for the same order is a second way to pay it, which is how a customer ends up
 * paying twice.
 */

import { eq, sql } from 'drizzle-orm';

import { createPaymentLink } from '../adapters/razorpay/resources.js';
import type { RazorpayClient } from '../adapters/razorpay/client.js';
import type { Database } from '../db/client.js';
import { recoveryCases } from '../db/schema/cases.js';
import { appendEvent } from '../db/repos/cases.js';
import { formatINR, type Paise } from '../core/money.js';

export interface EnsureLinkInput {
  db: Database;
  razorpay: RazorpayClient;
  caseId: string;
  merchantId: string;
  merchantName: string;
  amountPaise: number;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  /** The case deadline; the link should not outlive the recovery window. */
  expiresAt: Date | null;
  now: Date;
}

export type EnsureLinkResult =
  | { ok: true; url: string; created: boolean }
  | { ok: false; reason: string };

export async function ensurePaymentLink(input: EnsureLinkInput): Promise<EnsureLinkResult> {
  const { db, caseId } = input;

  const rows = await db
    .select({
      id: recoveryCases.rzpPaymentLinkId,
      url: recoveryCases.rzpPaymentLinkUrl,
      state: recoveryCases.state,
    })
    .from(recoveryCases)
    .where(eq(recoveryCases.id, caseId))
    .limit(1);

  const row = rows.at(0);
  if (!row) return { ok: false, reason: 'case not found' };

  // Already have one. Reuse it — a fresh link would give the customer two ways
  // to pay the same order.
  if (row.url) return { ok: true, url: row.url, created: false };

  // Razorpay requires a minimum of Rs 1. A zero-amount case is a parse failure
  // upstream, and creating a link for it would fail with a confusing error.
  if (input.amountPaise < 100) {
    return { ok: false, reason: `amount ${input.amountPaise} paise is below the Razorpay minimum` };
  }

  try {
    const link = await createPaymentLink(input.razorpay, {
      amountPaise: input.amountPaise,
      currency: 'INR',
      description: `Payment to ${input.merchantName} — ${formatINR(input.amountPaise as Paise, { compact: true })}`,
      // Our case id, so an inbound `payment_link.paid` maps straight back.
      referenceId: caseId,
      customer: {
        ...(input.customerName ? { name: input.customerName } : {}),
        ...(input.customerEmail ? { email: input.customerEmail } : {}),
        ...(input.customerPhone ? { contact: input.customerPhone } : {}),
      },
      // Never outlive the recovery window: a link that still works after the
      // case is written off collects money for an order nobody is tracking.
      ...(input.expiresAt ? { expireBy: input.expiresAt } : {}),
      // OFF, deliberately. Razorpay would send its own SMS and email, bypassing
      // consent, quiet hours and the cross-case frequency cap. Every customer
      // touch goes through one gate or the cap is not a cap.
      notifySms: false,
      notifyEmail: false,
      notes: { vyavas_case_id: caseId },
    });

    const url = typeof link.short_url === 'string' ? link.short_url : null;
    const id = typeof link.id === 'string' ? link.id : null;

    if (!url) return { ok: false, reason: 'Razorpay returned no short_url' };

    // Only claim the case if it has not acquired a link in the meantime — two
    // concurrent rungs could both have found it empty.
    const updated = await db
      .update(recoveryCases)
      .set({ rzpPaymentLinkId: id, rzpPaymentLinkUrl: url, updatedAt: sql`now()` })
      .where(sql`${recoveryCases.id} = ${caseId} and ${recoveryCases.rzpPaymentLinkUrl} is null`)
      .returning({ id: recoveryCases.id });

    if (updated.length === 0) {
      // Lost the race. Read back whatever the winner stored.
      const [again] = await db
        .select({ url: recoveryCases.rzpPaymentLinkUrl })
        .from(recoveryCases)
        .where(eq(recoveryCases.id, caseId));
      return again?.url
        ? { ok: true, url: again.url, created: false }
        : { ok: false, reason: 'link created but not stored' };
    }

    await appendEvent(db, {
      caseId,
      merchantId: input.merchantId,
      kind: 'payment_link_created',
      actor: 'workflow',
      payload: { rzpPaymentLinkId: id, url, amountPaise: input.amountPaise },
    });

    return { ok: true, url, created: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}
