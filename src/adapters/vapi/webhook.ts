/**
 * Vapi webhook verification.
 *
 * Vapi echoes back the shared secret configured on the tool/server URL in the
 * `x-vapi-secret` header (a shared-secret compare, not an HMAC signature).
 *
 * Verification degrades to `unverified` — not a refusal — when
 * `VAPI_SERVER_SECRET` is unset, by deliberate choice for the trial phase:
 * every call this agent can place is already constrained to numbers on the
 * hard-coded allow-list (see `lib/env.ts`), so an unauthenticated request
 * cannot make this endpoint dial a real customer. It CAN still probe the
 * discount logic or the payment-link creation, which is exactly why this
 * needs to change before a real customer is ever called — see the `reason`
 * this returns; it is meant to be visible in logs as a standing reminder.
 */

import { safeEqual } from '../../lib/crypto.js';

export const SECRET_HEADER = 'x-vapi-secret';

export type VerifyResult =
  | { ok: true; verified: true }
  | { ok: true; verified: false; reason: string }
  | { ok: false; reason: string };

export function verifyVapiWebhook(headerValue: string | null | undefined, configuredSecret: string | null): VerifyResult {
  if (!configuredSecret) {
    return {
      ok: true,
      verified: false,
      reason: 'VAPI_SERVER_SECRET is not set — accepting unverified. Set it before calling real customers.',
    };
  }

  if (!headerValue) {
    return { ok: false, reason: `missing ${SECRET_HEADER} header` };
  }

  if (!safeEqual(headerValue, configuredSecret)) {
    return { ok: false, reason: 'secret did not match' };
  }

  return { ok: true, verified: true };
}
