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

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [runLadder, sweepDeadlines],
});
