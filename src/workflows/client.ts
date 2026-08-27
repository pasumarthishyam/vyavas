/**
 * The Inngest client and the event vocabulary.
 *
 * Inngest v4 defines events with `eventType(name)` rather than the v3
 * `EventSchemas` record. Schemas are left off deliberately: they take a
 * Standard Schema, which our zod version predates, and a version mismatch there
 * would fail at runtime inside the SDK rather than at our boundary. The payload
 * shapes are declared as plain interfaces below and asserted at the send site,
 * which is where a wrong shape should be caught anyway.
 *
 * Every event carries `merchantId`. Everything in this system is tenant-scoped,
 * and a workflow that forgets that operates across all of them.
 */

import { Inngest, eventType } from 'inngest';

export const inngest = new Inngest({ id: 'vyavas' });

// ─── event names ─────────────────────────────────────────────────────────────

/** A case has been diagnosed and has a ladder stamped on it. Starts execution. */
export const caseDiagnosed = eventType('case/diagnosed');

/** The case ended — paid, aborted or written off. Cancels any running ladder. */
export const caseResolved = eventType('case/resolved');

/** An outage cleared. Wakes every case parked on it. */
export const downtimeResolved = eventType('downtime/resolved');

/** Periodic sweep for cases past their deadline. */
export const sweepRequested = eventType('sweep/requested');

// ─── payload shapes ──────────────────────────────────────────────────────────

export interface CaseDiagnosedData {
  caseId: string;
  merchantId: string;
  causeClass: string;
  policyId: string;
  policyVersion: number;
  cohort: 'treatment' | 'holdout';
  attended: boolean;
}

export interface CaseResolvedData {
  caseId: string;
  merchantId: string;
  outcome: 'recovered' | 'aborted' | 'lost';
  reason: string;
}

export interface DowntimeResolvedData {
  downtimeId: string;
  method: string;
  bank: string | null;
}

export const EVENT_NAMES = {
  caseDiagnosed: 'case/diagnosed',
  caseResolved: 'case/resolved',
  downtimeResolved: 'downtime/resolved',
  sweepRequested: 'sweep/requested',
} as const;
