/**
 * The agent's self-audit.
 *
 * Answers the question the dashboard cannot: **which cases did we lose without
 * the agent ever acting, and why?**
 *
 * Those are the fixable losses. A customer who received three good messages and
 * did not pay is a customer who did not want to pay — there is no bug there. A
 * case that sent nothing because the payment link could not be composed, or
 * because the ladder abandoned a rung against a wrong retry time, is a defect
 * with a price tag attached, and today nothing surfaces it.
 *
 * Every count below is SQL. Claude receives the buckets and looks for the joins
 * a GROUP BY cannot make — that forty `channel_deliverable` aborts all belong
 * to one merchant onboarded last Tuesday, that `deferral_limit` appearing
 * beside `within_frequency_cap` means the cap arithmetic is wrong rather than
 * the merchant being busy.
 *
 * Read-only. It computes a report and writes nothing.
 */

import { sql } from 'drizzle-orm';

import type { Paise } from '../core/money.js';
import type { Database } from '../db/client.js';
import {
  type AuditFacts,
  type AuditReport,
  type FailureBucket,
  auditLedger,
  fallbackReport,
} from '../adapters/claude/index.js';

/**
 * The event kinds that mean a rung did not become an action.
 *
 * `rung_fired` is deliberately absent: this job is about what did NOT happen.
 * `rung_deferred` IS present even though deferring is usually correct, because
 * the pathological case — a gate that defers forever against a wrong retry time
 * — is invisible unless you can see the volume.
 */
/*
 * Only kinds `appendEvent` actually writes.
 *
 * This listed `no_channel`, `illegal_transition` and `reason_mismatch` as well.
 * All three are real outcomes in the code — the first is a `SendOutcome`, the
 * other two are `transitionCase` rejections — but none of them is ever
 * PERSISTED as an event, so the query could never match one and the prompt was
 * describing evidence that cannot exist. An audit that hunts for something
 * unfindable reports a clean window it did not actually verify.
 */
const FAILURE_KINDS = [
  'rung_aborted',
  'rung_deferred',
  'rung_abandoned',
  'rung_uncomposable',
] as const;

const SAMPLE_CASE_IDS = 3;
const SAMPLE_NOTES = 5;

/**
 * Three fragments that must be SQL text rather than bound parameters.
 *
 * An `IN` list and the bounds of an array slice are syntax, not values —
 * `kind in $1` binds one parameter holding an array, which is a type error, and
 * `arr[1:$1]` will not parse at all.
 *
 * `sql.raw` is safe here and only here: all three are module-level constants
 * declared above, with no path from user input, a merchant, or a webhook. Do
 * not extend this pattern to anything that varies at runtime.
 */
const KIND_LIST = sql.raw(FAILURE_KINDS.map((k) => `'${k}'`).join(', '));
const CASE_ID_SLICE = sql.raw(String(SAMPLE_CASE_IDS));
const NOTE_SLICE = sql.raw(String(SAMPLE_NOTES));

function rowsOf(result: unknown): Record<string, unknown>[] {
  const list = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  return list as Record<string, unknown>[];
}

function num(v: unknown): number {
  return Number(v ?? 0);
}

/** Strings out of a Postgres array, whatever the driver hands back. */
function stringsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

export interface AuditOptions {
  db: Database;
  now: Date;
  windowDays?: number;
  merchantId?: string;
  /** Skip the model and return the deterministic report. */
  skipAnalysis?: boolean;
}

/**
 * Count the buckets.
 *
 * The `distinct` in every aggregate is load-bearing. A single case can emit a
 * dozen `rung_deferred` events, and summing `amount_at_risk_paise` across
 * events rather than across cases would report twelve times the money at risk —
 * which is exactly the kind of confidently wrong number this whole design is
 * built to keep out of a report.
 */
export async function gatherAuditFacts(opts: AuditOptions): Promise<AuditFacts> {
  const { db } = opts;
  const windowDays = opts.windowDays ?? 7;
  const merchantFilter = opts.merchantId
    ? sql`and c.merchant_id = ${opts.merchantId}`
    : sql``;

  const totals = rowsOf(
    await db.execute(sql`
      with span as (
        select c.*
        from recovery_cases c
        where c.created_at > now() - make_interval(days => ${windowDays}::int)
          ${merchantFilter}
      ),
      messaged as (
        select distinct case_id
        from message_log
        where case_id is not null and suppressed_reason is null
      )
      select
        count(*)::int                                                   as total_cases,
        count(*) filter (where span.state = 'lost')::int                as lost_cases,
        coalesce(sum(span.amount_at_risk_paise)
          filter (where span.state = 'lost'), 0)::bigint                as lost_amount,
        count(*) filter (
          where span.state = 'lost' and m.case_id is null)::int         as lost_silent,
        coalesce(sum(span.amount_at_risk_paise) filter (
          where span.state = 'lost' and m.case_id is null), 0)::bigint  as lost_silent_amount
      from span
      left join messaged m on m.case_id = span.id
    `),
  )[0];

  const buckets = rowsOf(
    await db.execute(sql`
      with events as (
        select e.case_id, e.kind, e.reason, e.payload, c.merchant_id,
               c.amount_at_risk_paise
        from case_events e
        join recovery_cases c on c.id = e.case_id
        where e.kind in (${KIND_LIST})
          and e.occurred_at > now() - make_interval(days => ${windowDays}::int)
          ${merchantFilter}
      ),
      messaged as (
        select distinct case_id
        from message_log
        where case_id is not null and suppressed_reason is null
      ),
      per_case as (
        select distinct on (e.kind, e.reason, e.case_id)
               e.kind, e.reason, e.case_id, e.merchant_id,
               e.amount_at_risk_paise,
               (m.case_id is null) as silent,
               e.payload
        from events e
        left join messaged m on m.case_id = e.case_id
      )
      select
        kind,
        reason,
        count(*)::int                                        as case_count,
        coalesce(sum(amount_at_risk_paise), 0)::bigint       as amount,
        count(*) filter (where silent)::int                  as silent_count,
        count(distinct merchant_id)::int                     as merchants,
        (array_agg(case_id::text order by case_id))[1:${CASE_ID_SLICE}]  as sample_ids,
        (array_agg(distinct coalesce(payload->>'note', payload->>'detail'))
           filter (where payload->>'note' is not null
                      or payload->>'detail' is not null))[1:${NOTE_SLICE}] as notes
      from per_case
      group by kind, reason
      order by sum(amount_at_risk_paise) desc
    `),
  );

  const mapped: FailureBucket[] = buckets.map((b) => ({
    kind: String(b.kind),
    reason: (b.reason as string | null) ?? null,
    caseCount: num(b.case_count),
    amountAtRisk: num(b.amount) as Paise,
    casesWithNoMessage: num(b.silent_count),
    distinctMerchants: num(b.merchants),
    sampleCaseIds: stringsOf(b.sample_ids),
    sampleNotes: stringsOf(b.notes).map((n) => n.slice(0, 160)),
  }));

  return {
    windowDays,
    generatedAt: opts.now,
    totalCasesInWindow: num(totals?.total_cases),
    totalLostCases: num(totals?.lost_cases),
    lostAmount: num(totals?.lost_amount) as Paise,
    lostWithNoMessage: num(totals?.lost_silent),
    lostWithNoMessageAmount: num(totals?.lost_silent_amount) as Paise,
    buckets: mapped,
  };
}

export interface AuditOutcome {
  facts: AuditFacts;
  report: AuditReport;
  source: 'claude' | 'fallback';
  error: string | null;
}

export async function runSelfAudit(opts: AuditOptions): Promise<AuditOutcome> {
  const facts = await gatherAuditFacts(opts);

  if (opts.skipAnalysis) {
    return { facts, report: fallbackReport(facts), source: 'fallback', error: 'analysis skipped' };
  }

  const analysed = await auditLedger(facts);
  if (analysed.ok) {
    return { facts, report: analysed.value, source: 'claude', error: null };
  }

  return {
    facts,
    report: fallbackReport(facts),
    source: 'fallback',
    error: `${analysed.error.failure}: ${analysed.error.detail}`,
  };
}
