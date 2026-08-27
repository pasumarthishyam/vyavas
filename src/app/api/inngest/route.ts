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
// Ladder steps are short (a gate check and a write), but the sweep can walk 200
// cases. Well under Vercel's ceiling; raised so a slow round trip to Mumbai
// cannot truncate a run mid-step.
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [runLadder, sweepDeadlines],
});
