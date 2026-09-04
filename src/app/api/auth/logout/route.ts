import { NextResponse } from 'next/server';

import { SESSION_COOKIE } from '../../../../lib/session';

/**
 * Sign out.
 *
 * Clears the cookie. It does NOT bump the session epoch, and that is the right
 * default: bumping would sign the user out of every other browser too, which is
 * a security action ("I think someone has my session") rather than the ordinary
 * one ("I am done on this machine"). `bumpSessionEpoch` is there for the former.
 *
 * Public in the middleware, because signing out must work even when the token
 * has already expired — a logout that 401s leaves a stale cookie in place.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(request.url).protocol === 'https:',
    path: '/',
    maxAge: 0,
  });
  return response;
}
