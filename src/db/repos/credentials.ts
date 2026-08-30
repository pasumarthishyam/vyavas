/**
 * Per-merchant credentials.
 *
 * The one place a stored secret is decrypted. Everything that needs to talk to
 * Razorpay or Resend on a merchant's behalf comes through here, which is what
 * makes "could we ever send on the wrong merchant's account?" a question with a
 * single place to look.
 *
 * Why the database and not the environment:
 *
 *   - Adding a merchant is a row, not a redeploy. `TRADESMETRIX_RAZORPAY_KEY`
 *     does not generalise; merchant #3 needs new variables AND code that knows
 *     their name.
 *   - Credentials arrive with the merchant they belong to. A function that has
 *     a `merchantId` cannot accidentally use another tenant's key, because it
 *     never had one in scope.
 *   - Platform env vars are injected into every deployment and readable by
 *     anyone with project access. These columns are AES-256-GCM ciphertext.
 *
 * Env stays the home of exactly one secret that matters — `ENCRYPTION_KEY` —
 * plus the things that genuinely are platform-wide (the database, the WhatsApp
 * business number, Anthropic, Inngest).
 *
 * FALLBACK: when a merchant has no stored credential, the env value is used and
 * the result says so. That keeps local development and the existing scripts
 * working, and `source: 'env'` is surfaced in the console so a merchant running
 * on someone else's fallback key is visible rather than assumed.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { merchants, razorpayConnections } from '../schema/tenancy.js';
import { decryptSecret } from '../../lib/crypto.js';
import { env } from '../../lib/env.js';

export type CredentialSource = 'merchant' | 'env' | 'missing';

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
  mode: 'test' | 'live';
  source: CredentialSource;
}

export interface EmailCredentials {
  apiKey: string;
  from: string | null;
  source: CredentialSource;
}

/** Where messages for this merchant actually land. Null means the real person. */
export interface MerchantRouting {
  whatsappRedirectTo: string | null;
  emailRedirectTo: string | null;
}

export interface MerchantCredentials {
  merchantId: string;
  slug: string;
  name: string;
  razorpay: RazorpayCredentials | null;
  email: EmailCredentials | null;
  routing: MerchantRouting;
  /** Live means real money moved through this account. Drives the UI warning. */
  mode: 'test' | 'live' | 'unknown';
}

/**
 * Load and decrypt everything one merchant needs to act.
 *
 * One round trip. Called per workflow step rather than memoised globally: a
 * cached credential set keyed on nothing is exactly how a message ends up on
 * the wrong account after a merchant switch.
 */
export async function loadMerchantCredentials(
  db: Database,
  merchantId: string,
): Promise<MerchantCredentials | null> {
  const rows = await db
    .select({ m: merchants, c: razorpayConnections })
    .from(merchants)
    .leftJoin(
      razorpayConnections,
      and(
        eq(razorpayConnections.merchantId, merchants.id),
        eq(razorpayConnections.status, 'active'),
      ),
    )
    .where(eq(merchants.id, merchantId))
    .limit(1);

  const row = rows.at(0);
  if (!row) return null;

  const { m, c } = row;
  const e = env();

  // ── Razorpay ──
  let razorpay: RazorpayCredentials | null = null;

  if (c?.keyId && c.keySecretEnc) {
    razorpay = {
      keyId: c.keyId,
      keySecret: decryptSecret(c.keySecretEnc),
      mode: c.mode,
      source: 'merchant',
    };
  } else if (e.RAZORPAY_API_KEY && e.RAZORPAY_API_SECRET) {
    razorpay = {
      keyId: e.RAZORPAY_API_KEY,
      keySecret: e.RAZORPAY_API_SECRET,
      // Razorpay key ids carry their own mode. Reading it from the key rather
      // than assuming keeps a live key from being labelled test in the UI.
      mode: e.RAZORPAY_API_KEY.startsWith('rzp_live') ? 'live' : 'test',
      source: 'env',
    };
  }

  // ── email ──
  let email: EmailCredentials | null = null;

  if (m.resendApiKeyEnc) {
    email = {
      apiKey: decryptSecret(m.resendApiKeyEnc),
      from: m.emailFrom,
      source: 'merchant',
    };
  } else if (e.RESEND_API_KEY) {
    email = { apiKey: e.RESEND_API_KEY, from: m.emailFrom ?? e.EMAIL_FROM ?? null, source: 'env' };
  }

  return {
    merchantId: m.id,
    slug: m.slug,
    name: m.name,
    razorpay,
    email,
    routing: {
      whatsappRedirectTo: m.whatsappRedirectTo,
      emailRedirectTo: m.emailRedirectTo,
    },
    mode: c?.mode ?? razorpay?.mode ?? 'unknown',
  };
}

/**
 * The merchant's webhook secret, for signature verification.
 *
 * Separate from `loadMerchantCredentials` because it is needed BEFORE the
 * payload can be trusted, and the caller at that point knows only which URL the
 * delivery arrived on.
 */
/**
 * Slugs a URL path is allowed to mean.
 *
 * A webhook URL is typed into a payment provider's dashboard once and then
 * forgotten. Renaming a merchant silently 404s every delivery from that moment
 * on, and the only symptom is cases that stop appearing — Razorpay retries a
 * few times, gives up, and the money is simply never recovered.
 *
 * So a `rzp-` prefix is optional in the path: `rzp-tradesmetrix` and
 * `tradesmetrix` both resolve to the same merchant. It costs one extra
 * comparison and removes an entire class of silent outage. It is NOT a security
 * relaxation — the signature is still verified against that merchant's own
 * secret, so naming the right merchant is necessary and nowhere near
 * sufficient.
 */
export function slugCandidates(slug: string): string[] {
  const bare = slug.replace(/^rzp-/, '');
  return Array.from(new Set([slug, bare, `rzp-${bare}`]));
}

export async function loadWebhookSecret(
  db: Database,
  slug: string,
): Promise<{ merchantId: string; secret: string } | null> {
  const rows = await db
    .select({ id: merchants.id, enc: razorpayConnections.webhookSecretEnc })
    .from(merchants)
    .leftJoin(
      razorpayConnections,
      and(
        eq(razorpayConnections.merchantId, merchants.id),
        eq(razorpayConnections.status, 'active'),
      ),
    )
    .where(inArray(merchants.slug, slugCandidates(slug)))
    .limit(1);

  const row = rows.at(0);
  if (!row) return null;

  if (row.enc) return { merchantId: row.id, secret: decryptSecret(row.enc) };

  // ── the env fallback, and why it is narrow ──
  //
  // A single global secret keeps a one-merchant install working before anyone
  // has run `merchant -- connect --webhook-secret`. With TWO merchants it
  // becomes a hole: both endpoints would verify against the same secret, so a
  // payload signed by the live account would be accepted at the sandbox URL
  // and ingested as a sandbox event — fabricated cases against real customer
  // records, from a caller holding a secret for a different account entirely.
  //
  // So the fallback applies only while there is exactly one merchant. Past
  // that, a missing per-merchant secret is a refusal, and the endpoint's GET
  // says `secretConfigured: false` so it is visible from a browser rather than
  // discovered when a delivery is rejected.
  const counted = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(merchants)
    .where(sql`deleted_at is null`);

  if (Number(counted.at(0)?.n ?? 0) !== 1) return null;

  const fallback = env().RAZORPAY_WEBHOOK_SECRET;
  return fallback ? { merchantId: row.id, secret: fallback } : null;
}
