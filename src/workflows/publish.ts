/**
 * Publishing workflow events.
 *
 * The seam between ingest and execution. Ingest decides a case exists and what
 * ladder applies; this hands that to the durable engine.
 *
 * Deliberately separate from the ingest handlers so the pipeline stays testable
 * without a workflow engine running — the Stage 4 tests call `processEvent`
 * directly and never touch Inngest. Publishing is the caller's decision.
 */

import { inngest } from './client.js';
import type { CaseDiagnosedData, CaseResolvedData } from './client.js';

export interface PublishResult {
  published: boolean;
  reason?: string;
}

/**
 * Start a ladder.
 *
 * Never called for a case that should not run one. The two checks here are
 * belt-and-braces: `run-ladder` also refuses an empty ladder, and Inngest's
 * `idempotency` key stops a duplicate event starting a second run. Three
 * independent guards, because the failure mode is doubled messages to a real
 * person.
 */
export async function publishCaseDiagnosed(data: CaseDiagnosedData): Promise<PublishResult> {
  if (!data.policyId) return { published: false, reason: 'no policy stamped' };

  await inngest.send({ name: 'case/diagnosed', data: data as unknown as Record<string, unknown> });
  return { published: true };
}

/**
 * Stop a ladder.
 *
 * `run-ladder` declares `cancelOn` for this event, so sending it kills the run
 * wherever it is sleeping — no polling, no check we might forget to add to a
 * new rung type. This is the kill switch, and it is why `order.paid` ingest
 * must publish it promptly.
 */
export async function publishCaseResolved(data: CaseResolvedData): Promise<PublishResult> {
  await inngest.send({ name: 'case/resolved', data: data as unknown as Record<string, unknown> });
  return { published: true };
}

export async function publishSweepRequested(merchantId?: string): Promise<PublishResult> {
  await inngest.send({ name: 'sweep/requested', data: { merchantId: merchantId ?? null } });
  return { published: true };
}
