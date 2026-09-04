/**
 * The front door.
 *
 * Every request to this app passes through here, and anything that is not
 * explicitly public needs a validly signed session cookie. Before this file
 * existed there was no authentication at all: the deployment is on a public
 * URL, and anyone who found it could read every case and every customer
 * contact, copy the abandoned-cart API key, switch send mode to live, and press
 * Start on a real customer.
 *
 * ── WHERE THIS FILE LIVES IS PART OF THE FEATURE ──
 *
 * `src/middleware.ts`, beside `app/` — NOT the repository root. This project
 * has a `src` directory, and Next.js looks for middleware next to `app`. A
 * middleware at the repo root is not an error and not a warning: it is silently
 * ignored, `next build` succeeds, the route table prints normally, and every
 * page serves to anyone. The only visible tell is the absence of a `Middleware`
 * line in the build output and an empty `middleware` object in
 * `.next/server/middleware-manifest.json`. This file was written at the root
 * first and shipped nothing. Do not move it back.
 *
 * ── the signature is actually checked ──
 *
 * The usual shape of a Next.js middleware gate is `if (!cookies.get(name))
 * redirect`, which is not authentication — a cookie is client-controlled, so
 * anyone can set one. `verifySession` runs a real HMAC check here, on the Edge
 * runtime, which is why `lib/session.ts` is built on Web Crypto rather than
 * `node:crypto`.
 *
 * What is deliberately NOT checked here is anything needing the database: that
 * the user still exists, is not disabled, and is on the current session epoch.
 * There is no database in the Edge runtime. `lib/auth.ts` re-checks all three
 * on the server side of every page and route, so this is a cheap first gate and
 * not the only one.
 *
 * ── the public list ──
 *
 * Everything below is public because something that is not a person calls it,
 * and each has its own authentication:
 *
 *   /api/webhooks/razorpay      HMAC-SHA256 over the raw body
 *   /api/webhooks/whatsapp      Meta's verify token, then delivery receipts
 *   /api/voice-agent/webhook    the Vapi shared secret header
 *   /api/abandoned-cart/:slug/webhook   a per-merchant bearer key
 *   /api/inngest                Inngest's own request signing
 *   /api/health                 a liveness probe, and it says nothing
 *
 * Adding a path here grants the whole internet access to it. The abandoned-cart
 * entry is the one to be careful with: only the `/webhook` leaf is public, and
 * the sibling routes under `/api/abandoned-cart` (`keys`, `list`, `sync`) hand
 * back the merchant's API key and their customer list, so the pattern is
 * anchored at both ends rather than matched as a prefix.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE, verifySession } from './lib/session';

const PUBLIC_EXACT = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/health',
]);

const PUBLIC_PREFIXES = ['/api/webhooks/', '/api/inngest'];

const PUBLIC_EXACT_PATTERNS = [
  /^\/api\/voice-agent\/webhook$/,
  // ONLY the webhook leaf. `/api/abandoned-cart/keys` must never match this.
  /^\/api\/abandoned-cart\/[^/]+\/webhook$/,
];

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  return PUBLIC_EXACT_PATTERNS.some((re) => re.test(pathname));
}

/**
 * The path, forwarded to the server components below.
 *
 * A layout cannot read the URL it is rendering — Next gives a page its params
 * and nothing else — and `(app)/layout.tsx` needs it to build the `next=` that
 * returns someone to where they were headed after they sign in. The header is
 * set on the REQUEST, so it never reaches the browser.
 */
const PATHNAME_HEADER = 'x-vyavas-pathname';

function forward(request: NextRequest, pathname: string, search: string): NextResponse {
  const headers = new Headers(request.headers);
  headers.set(PATHNAME_HEADER, `${pathname}${search}`);
  return NextResponse.next({ request: { headers } });
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const secret = process.env.SESSION_SECRET;

  // No secret means no token can be verified, so nothing can be trusted. Fail
  // closed — a misconfigured deployment must be shut, not open.
  if (!secret || secret.length < 32) {
    return deny(request, pathname, search, 'session_secret_not_configured');
  }

  const verdict = await verifySession(request.cookies.get(SESSION_COOKIE)?.value, secret);
  if (!verdict.valid) {
    return deny(request, pathname, search, verdict.reason);
  }

  // Signed cookie accepted here; `(app)/layout.tsx` still re-checks the things
  // the Edge cannot see (the user exists, is enabled, is on the current epoch).
  return forward(request, pathname, search);
}

/**
 * An API route gets JSON and a 401; a page gets a redirect to the login form.
 *
 * Redirecting a fetch would hand the caller a 200 with an HTML login page in
 * it, which client code parses as a successful response and renders as a blank
 * or broken panel — a confusing failure that looks like a bug rather than a
 * sign-out.
 */
function deny(
  request: NextRequest,
  pathname: string,
  search: string,
  reason: string,
): NextResponse {
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ ok: false, reason: 'unauthenticated', detail: reason }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  // Come back to where they were trying to go. Path-only, and re-validated on
  // the way out, so this cannot be turned into an open redirect to another host.
  if (pathname !== '/') url.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(url);
}

/**
 * Everything except Next's own static output and the favicon.
 *
 * Written as an exclusion rather than a list of protected paths on purpose: a
 * new page added later is protected by default, and someone has to think in
 * order to make it public. The other way round, a new page is public by default
 * and nobody notices.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
