import { serve } from 'inngest/next';

import { inngest } from '../../../workflows/client';
import { runLadder } from '../../../workflows/functions/run-ladder';
import { sweepDeadlines } from '../../../workflows/functions/sweep-deadlines';

/**
 * The Inngest endpoint.
 *
 * Every workflow function has to be listed here or it is simply never
 * registered — a function that exists in the codebase but is missing from this
 * array fails silently, which is the one Inngest gotcha worth a comment.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Ladder steps are short (a gate check and a write). 60s is the ceiling every
// Vercel plan allows, Hobby included — 300 is only available higher up, and a
// value the plan refuses fails the deployment rather than degrading. The sweep
// walks a small enough batch to finish well inside this.
export const maxDuration = 60;

/**
 * Where Inngest should call us back.
 *
 * Pinned, not derived. Left to itself the SDK works out its own public URL from
 * the incoming request, and behind Vercel's apex→www redirect it derived the
 * APEX — so it registered `https://vyavas.com/api/inngest`, a URL that answers
 * every request with a 308. Inngest's `/fn/register` rejected that with a 400,
 * our route relayed the 400, and the sync retried every five seconds
 * indefinitely.
 *
 * Nothing in that failure names a URL: the Vercel log shows `PUT 400` on a
 * route that is working perfectly, and the only trace of the real cause is the
 * `Referer` header and an outbound call to api.inngest.com in the request
 * detail.
 *
 * `APP_URL` is the same origin used for payment-link callbacks, so the two
 * cannot drift apart. It must be the canonical host — the one that does NOT
 * redirect.
 */
const origin = process.env.APP_URL ?? 'https://www.vyavas.com';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [runLadder, sweepDeadlines],
  serveOrigin: origin,
  servePath: '/api/inngest',
});
