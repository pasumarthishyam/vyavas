/**
 * Customer identity.
 *
 * Getting this wrong is not a data-tidiness problem. The cross-case frequency
 * cap is keyed on `customer_id`, so the same human stored under two rows gets
 * two independent message budgets and twice the messages. Resolving a payment's
 * email and contact back to ONE row is what makes the cap real.
 */

import { and, eq, isNotNull, or, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { customers } from '../schema/customers.js';

/**
 * India-first E.164 normalisation.
 *
 * Razorpay hands back `9876543210`, `+919876543210` and `919876543210` for the
 * same person depending on how checkout was filled in. Storing them verbatim
 * creates three customers with three budgets.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 0) return null;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  return `+${digits}`;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 && trimmed.includes('@') ? trimmed : null;
}

export interface UpsertCustomerInput {
  merchantId: string;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  rzpCustomerId?: string | null;
  externalRef?: string | null;
  locale?: string | null;
}

/**
 * Find the existing customer or create one.
 *
 * Matches on phone first: in India it is the more reliable identifier, it is
 * what WhatsApp and SMS need, and checkout emails are frequently typos or
 * throwaways. Never merges two existing rows — that is a destructive operation
 * and belongs behind a human decision, not inside a webhook handler.
 */
export async function upsertCustomer(
  db: Database,
  input: UpsertCustomerInput,
): Promise<string | null> {
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);

  // Nothing to reach them on. A case can still exist — it is revenue at risk —
  // but it has no customer, and the ladder will find no eligible channel.
  if (!phone && !email) return null;

  const conditions = [
    phone ? eq(customers.phone, phone) : null,
    email ? eq(customers.email, email) : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null);

  const existing = await db
    .select()
    .from(customers)
    .where(and(eq(customers.merchantId, input.merchantId), or(...conditions)))
    // Phone matches sort first, so a phone hit wins over an email hit.
    .orderBy(sql`case when ${customers.phone} = ${phone ?? ''} then 0 else 1 end`)
    .limit(1);

  const found = existing.at(0);
  if (found) {
    // Backfill only what is missing. Never overwrite a known contact with a
    // different one — that would silently redirect messages to another person.
    const patch: Record<string, unknown> = {};
    if (!found.phone && phone) patch.phone = phone;
    if (!found.email && email) patch.email = email;
    if (!found.name && input.name) patch.name = input.name;
    if (!found.rzpCustomerId && input.rzpCustomerId) patch.rzpCustomerId = input.rzpCustomerId;

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = sql`now()`;
      await db.update(customers).set(patch).where(eq(customers.id, found.id));
    }
    return found.id;
  }

  const inserted = await db
    .insert(customers)
    .values({
      merchantId: input.merchantId,
      phone,
      email,
      name: input.name ?? null,
      rzpCustomerId: input.rzpCustomerId ?? null,
      externalRef: input.externalRef ?? null,
      locale: input.locale ?? 'en-IN',
    })
    .onConflictDoNothing()
    .returning({ id: customers.id });

  const row = inserted.at(0);
  if (row) return row.id;

  // Lost an insert race against a concurrent webhook for the same person.
  const retry = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.merchantId, input.merchantId), or(...conditions)))
    .limit(1);
  return retry.at(0)?.id ?? null;
}

export async function getCustomer(db: Database, customerId: string) {
  const rows = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
  return rows.at(0) ?? null;
}

/** Global stop. Honoured everywhere, never expires. */
export async function optOutCustomer(
  db: Database,
  customerId: string,
  reason: string,
): Promise<void> {
  await db
    .update(customers)
    .set({ optedOutAt: sql`now()`, optOutReason: reason, updatedAt: sql`now()` })
    .where(and(eq(customers.id, customerId), sql`opted_out_at is null`));
}

export async function markUndeliverable(
  db: Database,
  customerId: string,
  channel: 'phone' | 'email',
): Promise<void> {
  await db
    .update(customers)
    .set(
      channel === 'phone'
        ? { phoneUndeliverableAt: sql`now()` }
        : { emailUndeliverableAt: sql`now()` },
    )
    .where(and(eq(customers.id, customerId), isNotNull(customers.id)));
}
