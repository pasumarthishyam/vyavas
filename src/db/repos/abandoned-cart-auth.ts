/**
 * The abandoned-cart webhook's own credential.
 *
 * Every other credential in `credentials.ts` is ours to call a provider with.
 * This one runs the other direction: it is what a MERCHANT'S OWN application
 * presents to prove a webhook call is really coming from them, at a URL that
 * is otherwise just sitting on the internet. Kept apart from
 * `loadMerchantCredentials` for that reason — this is not a secret we spend,
 * it is a secret we check.
 *
 * Stored encrypted and reversible (`encryptSecret`, not a one-way hash) on
 * purpose: the integration box on `/agents/abandoned-cart` shows the key back
 * in full every time the page loads, because whoever is wiring this up needs
 * to copy it more than once, and "shown only at creation" turns a lost tab
 * into a support ticket instead of a page reload.
 */

import { randomBytes } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { merchants } from '../schema/tenancy.js';
import { decryptSecret, encryptSecret, safeEqual } from '../../lib/crypto.js';
import { slugCandidates } from './credentials.js';

/** `vyv_cart_` + 32 random bytes, base64url — long enough that guessing is not a strategy. */
function generateKey(): string {
  return `vyv_cart_${randomBytes(32).toString('base64url')}`;
}

/** Issue a new key, replacing any previous one. Returns the plaintext once, to store and to show. */
export async function regenerateAbandonedCartApiKey(db: Database, merchantId: string): Promise<string> {
  const key = generateKey();
  await db
    .update(merchants)
    .set({ abandonedCartApiKeyEnc: encryptSecret(key), updatedAt: sql`now()` })
    .where(eq(merchants.id, merchantId));
  return key;
}

/** The current key in plain text, or null if one has never been generated. */
export async function getAbandonedCartApiKey(db: Database, merchantId: string): Promise<string | null> {
  const rows = await db
    .select({ enc: merchants.abandonedCartApiKeyEnc })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);
  const enc = rows.at(0)?.enc;
  return enc ? decryptSecret(enc) : null;
}

/**
 * Resolve `slug` to a merchant and check `presentedKey` against its stored key.
 *
 * Uses the same `slugCandidates` widening the Razorpay webhook uses — a
 * merchant rename must not silently 404 a URL a storefront has hard-coded —
 * and the same constant-time comparison every credential check in this
 * codebase uses, so a wrong guess cannot be narrowed by timing.
 */
export async function verifyAbandonedCartWebhookAuth(
  db: Database,
  slug: string,
  presentedKey: string | null,
): Promise<{ ok: true; merchantId: string } | { ok: false; reason: string }> {
  const rows = await db
    .select({ id: merchants.id, enc: merchants.abandonedCartApiKeyEnc })
    .from(merchants)
    .where(inArray(merchants.slug, slugCandidates(slug)))
    .limit(1);

  const row = rows.at(0);
  if (!row) return { ok: false, reason: 'no merchant for this URL' };
  if (!row.enc) {
    return {
      ok: false,
      reason: 'no abandoned-cart key has been generated yet — open Abandoned Cart Agent and generate one',
    };
  }
  if (!presentedKey) return { ok: false, reason: 'missing Authorization: Bearer <key> header' };

  const expected = decryptSecret(row.enc);
  if (!safeEqual(presentedKey, expected)) return { ok: false, reason: 'invalid key' };

  return { ok: true, merchantId: row.id };
}
