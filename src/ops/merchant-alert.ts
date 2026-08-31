/**
 * Merchant breakage alerts.
 *
 * `merchant_alert` used to be built with `signal: 'ladder'`, `affectedCases`
 * copied off the policy row, and `amountAtRisk: 0`. The table it was meant to
 * fill has existed since Stage 3 and the dashboard has read it since Stage 5;
 * nothing ever wrote a row.
 *
 * ── every number here is counted, not generated ──
 *
 * The cluster is a SQL query. The amount is a SUM. The baseline is this
 * merchant's own observed failure rate for this method over a longer window.
 * Claude receives all of them as facts and writes the sentence.
 *
 * That split is the point. A model that invents "roughly 50 cases" in an alert
 * a merchant acts on is worse than no alert, and the fix is not a better prompt
 * — it is not asking the model to count.
 *
 * ── severity is the policy's, not the model's ──
 *
 * Whether a condition is `warning` or `critical` decides whether somebody is
 * woken up. That belongs in a reviewed YAML table where it can be argued about,
 * not in a paragraph generator's judgement on the night.
 */

import { and, count, eq, gte, isNotNull, sql } from 'drizzle-orm';

import { type Paise, formatINR } from '../core/money.js';
import type { CauseClass } from '../core/taxonomy/cause-class.js';

import type { Database } from '../db/client.js';
import { paymentAttempts, recoveryCases } from '../db/schema/cases.js';
import { merchants } from '../db/schema/tenancy.js';
import { raiseMerchantAlert } from '../db/repos/alerts.js';
import { type AlertFacts, fallbackProse, writeAlertProse } from '../adapters/claude/index.js';

/** How far back the cluster is counted. */
const DEFAULT_WINDOW_HOURS = 6;
/** How far back "normal" is measured. Long enough to survive one bad day. */
const BASELINE_WINDOW_DAYS = 30;
/** This runs inside a ladder rung; the ladder does not wait long for prose. */
const PROSE_TIMEOUT_MS = 20_000;

/**
 * The condition's identity.
 *
 * Stable across wordings, because it is the unique key that decides whether a
 * still-broken condition accumulates into one row or pages once per case. The
 * reason leads because it is the most specific thing we know.
 */
export function alertSignal(parts: {
  causeClass: CauseClass | null;
  errorReason: string | null;
  bank: string | null;
  method: string;
}): string {
  const what = parts.errorReason ?? parts.causeClass ?? 'unknown';
  return `${what}:${parts.bank ?? 'all'}:${parts.method}`;
}

export interface ClusterKey {
  merchantId: string;
  causeClass: CauseClass | null;
  errorReason: string | null;
  bank: string | null;
  method: string;
}

/** Failure rate in basis points over a window, for one merchant and method. */
async function failureRateBps(
  db: Database,
  merchantId: string,
  method: string,
  since: Date,
): Promise<number | null> {
  const [row] = await db
    .select({
      total: count(),
      failed: sql<number>`count(*) filter (where ${paymentAttempts.succeeded} = false)::int`,
    })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.merchantId, merchantId),
        eq(paymentAttempts.method, method as never),
        gte(paymentAttempts.attemptedAt, since),
      ),
    );

  const total = Number(row?.total ?? 0);
  // Under about twenty attempts a rate is noise, and a merchant told their
  // "normal rate is 50%" off two attempts will never trust an alert again.
  if (total < 20) return null;
  return Math.round((Number(row?.failed ?? 0) / total) * 10_000);
}

export interface GatherAlertOptions {
  db: Database;
  key: ClusterKey;
  now: Date;
  windowHours?: number;
}

/**
 * Count the cluster.
 *
 * "At risk" excludes recovered cases: money that arrived is not at risk, and an
 * alert that counts it overstates the loss to a merchant who can check.
 */
export async function gatherAlertFacts(opts: GatherAlertOptions): Promise<AlertFacts | null> {
  const { db, key, now } = opts;
  const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
  const since = new Date(now.getTime() - windowHours * 3_600_000);

  const [merchant] = await db
    .select({ name: merchants.name })
    .from(merchants)
    .where(eq(merchants.id, key.merchantId))
    .limit(1);
  if (!merchant) return null;

  const match = [
    eq(recoveryCases.merchantId, key.merchantId),
    eq(recoveryCases.method, key.method as never),
    gte(recoveryCases.createdAt, since),
    sql`${recoveryCases.state} <> 'recovered'`,
  ];
  if (key.errorReason) match.push(eq(recoveryCases.errorReason, key.errorReason));
  if (key.bank) match.push(eq(recoveryCases.bank, key.bank));

  const [cluster] = await db
    .select({
      n: count(),
      amount: sql<number>`coalesce(sum(${recoveryCases.amountAtRiskPaise}), 0)::bigint`,
      onset: sql<Date | null>`min(${recoveryCases.createdAt})`,
    })
    .from(recoveryCases)
    .where(and(...match));

  const affectedCases = Number(cluster?.n ?? 0);
  if (affectedCases === 0) return null;

  // A representative case, for the diagnosis trace. The oldest one: it is the
  // one whose rationale explains how the condition started.
  const [sample] = await db
    .select({ rationale: recoveryCases.diagnosisRationale })
    .from(recoveryCases)
    .where(and(...match, isNotNull(recoveryCases.diagnosisRationale)))
    .orderBy(recoveryCases.createdAt)
    .limit(1);

  const rationale = Array.isArray(sample?.rationale)
    ? (sample.rationale as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  const baselineSince = new Date(now.getTime() - BASELINE_WINDOW_DAYS * 86_400_000);

  return {
    merchantName: merchant.name,
    signal: alertSignal(key),
    causeClass: key.causeClass ?? 'merchant_config',
    errorReason: key.errorReason,
    method: key.method,
    bank: key.bank,
    affectedCases,
    amountAtRisk: Number(cluster?.amount ?? 0) as Paise,
    onsetAt: cluster?.onset ? new Date(cluster.onset) : since,
    windowHours,
    baselineRateBps: await failureRateBps(db, key.merchantId, key.method, baselineSince),
    observedRateBps: await failureRateBps(db, key.merchantId, key.method, since),
    sampleRationale: rationale.slice(0, 6),
  };
}

export interface RaiseAlertOptions {
  db: Database;
  key: ClusterKey;
  /** From the policy rung. The model never decides this. */
  severity: 'info' | 'warning' | 'critical';
  now: Date;
  windowHours?: number;
  /** Skip the model. Set in dry-run and in tests. */
  skipProse?: boolean;
}

export interface RaiseAlertOutcome {
  raised: boolean;
  signal: string;
  affectedCases: number;
  amountAtRiskPaise: number;
  proseSource: 'claude' | 'fallback';
  proseError: string | null;
}

/**
 * Count the cluster, write the sentence, raise the alert.
 *
 * Returns `raised: false` when there is no cluster to report — a single case is
 * not a breakage, and the whole value of this alert is that it fires on a
 * pattern rather than on an event.
 */
export async function raiseAlertForCluster(opts: RaiseAlertOptions): Promise<RaiseAlertOutcome> {
  const facts = await gatherAlertFacts({
    db: opts.db,
    key: opts.key,
    now: opts.now,
    ...(opts.windowHours !== undefined ? { windowHours: opts.windowHours } : {}),
  });

  if (!facts) {
    return {
      raised: false,
      signal: alertSignal(opts.key),
      affectedCases: 0,
      amountAtRiskPaise: 0,
      proseSource: 'fallback',
      proseError: null,
    };
  }

  let prose = fallbackProse(facts);
  let proseSource: 'claude' | 'fallback' = 'fallback';
  let proseError: string | null = opts.skipProse ? 'prose generation skipped' : null;

  if (!opts.skipProse) {
    const written = await writeAlertProse(facts, { timeoutMs: PROSE_TIMEOUT_MS });
    if (written.ok) {
      prose = written.value;
      proseSource = 'claude';
    } else {
      proseError = `${written.error.failure}: ${written.error.detail}`.slice(0, 500);
    }
  }

  // The provenance goes into the detail rather than a column: `merchant_alerts`
  // predates this and its shape is read by the dashboard. A one-line suffix on
  // a fallback is enough to explain a terse alert without a migration.
  const detail =
    proseSource === 'claude'
      ? prose.detail
      : `${prose.detail} (Written without analysis — ${proseError ?? 'model unavailable'}.)`;

  await raiseMerchantAlert(opts.db, {
    merchantId: opts.key.merchantId,
    signal: facts.signal,
    severity: opts.severity,
    title: prose.title,
    detail,
    affectedCases: facts.affectedCases,
    amountAtRiskPaise: facts.amountAtRisk,
    baselineRateBps: facts.baselineRateBps,
    onsetAt: facts.onsetAt,
  });

  return {
    raised: true,
    signal: facts.signal,
    affectedCases: facts.affectedCases,
    amountAtRiskPaise: facts.amountAtRisk,
    proseSource,
    proseError,
  };
}

/** For logs and the dry-run report. */
export function describeOutcome(o: RaiseAlertOutcome): string {
  if (!o.raised) return `no cluster for ${o.signal} — nothing raised`;
  return (
    `${o.signal}: ${o.affectedCases} case(s), ` +
    `${formatINR(o.amountAtRiskPaise as Paise)} at risk (${o.proseSource})`
  );
}
