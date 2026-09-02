/**
 * Read-side queries for the abandoned-cart dashboard.
 *
 * Separate from `db/queries/dashboard.ts` for the same reason
 * `queries/voice-agent.ts` is: this agent has its own page and its own idea of
 * what's worth showing.
 */

import { desc, eq } from 'drizzle-orm';

import type { Database } from '../client.js';
import { abandonedCarts } from '../schema/abandoned-cart.js';
import { paiseFromColumn } from '../util.js';

const num = paiseFromColumn;

export interface AbandonedCartRow {
  id: string;
  externalCartId: string;
  status: string;
  customerName: string | null;
  customerEmail: string;
  customerPhone: string | null;
  amountPaise: number;
  discountAmountPaise: number | null;
  paymentLinkUrl: string | null;
  paymentLinkAmountPaise: number | null;
  paymentLinkExpiresAt: Date | null;
  paymentConfirmedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
}

export async function getRecentAbandonedCarts(
  db: Database,
  merchantId: string,
  limit = 50,
): Promise<AbandonedCartRow[]> {
  const rows = await db
    .select()
    .from(abandonedCarts)
    .where(eq(abandonedCarts.merchantId, merchantId))
    .orderBy(desc(abandonedCarts.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    externalCartId: r.externalCartId,
    status: r.status,
    customerName: r.customerName,
    customerEmail: r.customerEmail,
    customerPhone: r.customerPhone,
    amountPaise: num(r.amountPaise),
    discountAmountPaise: r.discountAmountPaise != null ? num(r.discountAmountPaise) : null,
    paymentLinkUrl: r.paymentLinkUrl,
    paymentLinkAmountPaise: r.paymentLinkAmountPaise != null ? num(r.paymentLinkAmountPaise) : null,
    paymentLinkExpiresAt: r.paymentLinkExpiresAt,
    paymentConfirmedAt: r.paymentConfirmedAt,
    failureReason: r.failureReason,
    createdAt: r.createdAt,
  }));
}
