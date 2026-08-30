/**
 * The webhook entry point.
 *
 * Deliberately NOT a Next.js route. This is a plain function over `(rawBody,
 * headers, deps)`, so the whole contract — signature verification, dedupe,
 * response codes, latency — is testable without a server running, and so the
 * HTTP layer can be Next, Express or anything else in five lines of wrapper.
 * Stage 5 wraps it; nothing about it changes when it does.
 *
 * The contract it has to honour:
 *
 *   1. VERIFY the raw bytes before parsing anything.
 *   2. CLAIM the delivery id, so a retry is a no-op rather than a second case.
 *   3. RETURN 200 FAST — under ~200ms. Razorpay retries on timeout, and a
 *      retry is a duplicate we then have to dedupe. Everything slow is handed
 *      to `processEvent` and awaited only when the caller asks.
 *   4. ALWAYS 200 on a delivery we have accepted, even if processing fails.
 *      A 500 makes Razorpay resend an event we have already claimed, and the
 *      dedupe will then swallow it — losing it entirely. The redrive sweep is
 *      what recovers a failed process, not Razorpay's retry.
 *
 * The one case that returns non-2xx is a bad signature. That is not a delivery
 * failure, it is an unauthenticated request, and it must be visible as 401.
 */

import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  deliveryId,
  verifyWebhook,
} from '../adapters/razorpay/webhook.js';
import type { Database } from '../db/client.js';
import { recordWebhook } from '../db/repos/webhooks.js';
import { type HandlerContext, type ProcessResult, processClaimedEvent } from './pipeline.js';
import type { WorkflowPublisher } from './handlers/payment-failed.js';

export interface WebhookDeps {
  db: Database;
  webhookSecret: string;
  /** Resolve the tenant this delivery belongs to. */
  resolveMerchant: (accountId: string | null) => Promise<MerchantSettings | null>;
  now: () => Date;
  /**
   * Hand the slow work to a queue. Stage 6 passes Inngest here.
   *
   * The default runs it inline, which is correct for tests and for a single
   * merchant, but means the response waits for the pipeline. Once volume is
   * real this must be a genuine enqueue or the 200 will not come back in time.
   */
  enqueue?: (job: () => Promise<ProcessResult>) => Promise<ProcessResult | null>;
  /**
   * Starts and stops ladders.
   *
   * Optional so the handler tests run with no workflow engine. In production
   * the route passes `workflowPublisher`, and without it a diagnosed case is
   * written correctly and then never executed.
   */
  publish?: WorkflowPublisher;
  /**
   * The tenant this delivery belongs to, when the caller already knows.
   *
   * The per-merchant endpoint does: the slug named the merchant, and its own
   * secret is what verified the signature. Passing it here stamps it on the
   * `webhook_events` row at claim time.
   *
   * That stamp is what makes redrive possible. `resolveMerchant` runs AFTER the
   * claim, so an event whose processing dies mid-flight is left claimed,
   * unprocessed, and — without this — unattributable: nothing on the row says
   * whose it was, and dedupe guarantees Razorpay's own retry can never rescue
   * it. Every such event was silently lost forever.
   */
  merchantId?: string | null;
}

export interface MerchantSettings {
  merchantId: string;
  holdoutBasisPoints: number;
  holdoutEnabled: boolean;
}

export interface WebhookResponse {
  status: number;
  body: {
    ok: boolean;
    reason?: string;
    eventId?: string;
    duplicate?: boolean;
    result?: ProcessResult | null;
  };
}

export type Headers = Record<string, string | string[] | undefined>;

/**
 * Genuinely case-insensitive header lookup.
 *
 * HTTP header names are case-insensitive by spec, but runtimes disagree about
 * what they hand you: Node's `IncomingMessage` lowercases, the Fetch `Headers`
 * object normalises on read, and a hand-built object in a test or a proxy
 * preserves whatever was sent. Missing the signature header because it arrived
 * as `X-Razorpay-Signature` would reject every legitimate delivery.
 */
function header(headers: Headers, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }
  return null;
}

export async function handleWebhookRequest(
  rawBody: string,
  headers: Headers,
  deps: WebhookDeps,
): Promise<WebhookResponse> {
  // 1 ── Verify the raw bytes. Nothing is parsed before this passes.
  const signature = header(headers, SIGNATURE_HEADER);
  const verified = verifyWebhook(rawBody, signature, deps.webhookSecret);

  if (!verified.ok) {
    // 401 for anything that failed authentication; 400 for a signed body we
    // could not read. Razorpay should not retry either, and both are worth
    // seeing in the logs as distinct problems.
    const unauthenticated =
      verified.reason === 'invalid_signature' || verified.reason === 'missing_signature';
    return {
      status: unauthenticated ? 401 : 400,
      body: { ok: false, reason: verified.reason },
    };
  }

  const eventId = deliveryId(rawBody, header(headers, EVENT_ID_HEADER));

  // 2 ── Claim it. Atomic: exactly one caller wins, even under concurrent
  //      redelivery of the same event.
  const claim = await recordWebhook(deps.db, {
    eventId,
    eventType: verified.event,
    payload: verified.envelope,
    // Stamped at claim time, not after `resolveMerchant` — an event whose
    // processing dies before that point still has to be attributable, or the
    // redrive sweep cannot pick it up.
    merchantId: deps.merchantId ?? null,
  });

  if (!claim.isNew) {
    // Already seen. 200, because anything else makes Razorpay retry a delivery
    // we have definitively handled.
    return { status: 200, body: { ok: true, eventId, duplicate: true } };
  }

  const accountId = verified.envelope.account_id ?? null;
  const merchant = await deps.resolveMerchant(accountId);

  if (!merchant) {
    // Accepted but unattributable. Still 200: retrying will not make the
    // merchant exist, and the row is on disk for investigation.
    return {
      status: 200,
      body: { ok: true, eventId, reason: 'unknown_merchant', result: null },
    };
  }

  const ctx: HandlerContext = {
    db: deps.db,
    merchantId: merchant.merchantId,
    now: deps.now(),
    holdoutBasisPoints: merchant.holdoutBasisPoints,
    holdoutEnabled: merchant.holdoutEnabled,
    ...(deps.publish ? { publish: deps.publish } : {}),
  };

  // 3 ── Hand off the slow part.
  const job = () => processClaimedEvent(deps.db, ctx, eventId, verified.envelope);
  const result = deps.enqueue ? await deps.enqueue(job) : await job();

  return { status: 200, body: { ok: true, eventId, duplicate: false, result } };
}

/**
 * Look up a merchant by Razorpay account id.
 *
 * Falls back to the sole connection when the envelope carries no account id —
 * a single-merchant install talking to its own keys, which is how the first
 * design partners will run. Multi-tenant installs always have the id.
 */
export function merchantResolver(lookup: {
  byAccountId: (accountId: string) => Promise<MerchantSettings | null>;
  soleMerchant?: () => Promise<MerchantSettings | null>;
}) {
  return async (accountId: string | null): Promise<MerchantSettings | null> => {
    if (accountId) {
      const found = await lookup.byAccountId(accountId);
      if (found) return found;
    }
    return lookup.soleMerchant ? lookup.soleMerchant() : null;
  };
}
