/**
 * The session token.
 *
 * A signed, stateless cookie: `<payload>.<hmac>`, both base64url. The payload
 * names the user, the moment the token expires, and the session epoch it was
 * issued under.
 *
 * ── why Web Crypto and not `node:crypto` ──
 *
 * This module is imported by `middleware.ts`, which Next.js runs on the Edge
 * runtime where `node:crypto` does not exist. Web Crypto's `subtle` is present
 * in both Edge and Node 20, so one implementation serves the middleware, the
 * server components and the API routes — and the middleware can do a REAL
 * signature check rather than the usual shortcut of trusting that a cookie
 * exists. A presence check is not authentication: anyone can set a cookie.
 *
 * ── why stateless ──
 *
 * A session table would mean a database round trip on every request, in a
 * serverless deployment whose function region was pinned to Mumbai precisely
 * because those round trips are expensive (see REGIONS.md). The cost of
 * statelessness is that a token cannot be individually revoked, and
 * `sessionEpoch` is the answer to that: it is carried in the payload, compared
 * against the user's current value on every authenticated request, and bumping
 * it invalidates every token that user holds at once.
 */

const ENCODER = new TextEncoder();

/** The cookie the browser carries. */
export const SESSION_COOKIE = 'vyavas_session';

/**
 * Eight hours.
 *
 * Long enough not to interrupt a working day, short enough that a token copied
 * off a machine is not useful for a week. The console can change send mode and
 * message real customers, so this is not a "remember me" surface.
 */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface SessionPayload {
  /** users.id */
  uid: string;
  /** users.sessionEpoch at issue time. */
  epoch: string;
  /** Unix seconds. */
  exp: number;
}

function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function keyFor(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Constant-time comparison.
 *
 * `crypto.subtle.verify` would do this for us, but it throws on a malformed
 * signature rather than returning false, and a malformed signature is exactly
 * what an attacker sends. Comparing the bytes ourselves keeps the failure path
 * boring. The loop never exits early, so the time it takes does not leak how
 * many bytes of a guess were right.
 */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function signSession(
  payload: SessionPayload,
  secret: string,
): Promise<string> {
  const body = b64urlEncode(ENCODER.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await keyFor(secret), ENCODER.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export type SessionVerdict =
  | { valid: true; payload: SessionPayload }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/**
 * Verify a token's signature and expiry.
 *
 * Says nothing about whether the user still exists, is still enabled, or is
 * still on the epoch the token names — those need the database, and the caller
 * that has one (`lib/auth.ts`) checks them. The middleware runs this alone,
 * which is enough to turn away anyone who did not receive a token from us.
 */
export async function verifySession(
  token: string | undefined | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SessionVerdict> {
  if (!token) return { valid: false, reason: 'malformed' };

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { valid: false, reason: 'malformed' };

  const body = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  let expected: Uint8Array;
  let provided: Uint8Array;
  try {
    expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', await keyFor(secret), ENCODER.encode(body)),
    );
    provided = b64urlDecode(providedSig);
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  // Signature BEFORE parsing. The payload is attacker-supplied until this
  // passes, and there is no reason to run a JSON parser over it first.
  if (!equalBytes(expected, provided)) return { valid: false, reason: 'bad_signature' };

  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SessionPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (
    typeof payload?.uid !== 'string' ||
    typeof payload?.epoch !== 'string' ||
    typeof payload?.exp !== 'number'
  ) {
    return { valid: false, reason: 'malformed' };
  }

  if (payload.exp <= nowSeconds) return { valid: false, reason: 'expired' };

  return { valid: true, payload };
}

/**
 * The cookie attributes every issued session carries.
 *
 * `httpOnly` so script on the page cannot read it, `sameSite: lax` so it is not
 * sent on cross-site POSTs — which is what stands between this console and a
 * CSRF that flips send mode to live from another tab.
 */
export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}
