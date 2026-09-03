import Link from 'next/link';

import { getDb } from '../../db/client';
import { selectMerchant } from '../../lib/merchant-context';
import { getCauseClassBreakdown, getMerchant, getRecentCases } from '../../db/queries/dashboard';
import { Empty } from '../../components/charts';
import { CasesLegend } from '../../components/cases-legend';
import { StatePill, causeLabel, inr, relativeTime } from '../../components/ui';
import type { CaseState } from '../../core/case/types';
import { resolveDateRange } from '../../lib/date-range';

export const dynamic = 'force-dynamic';

const LIVE: CaseState[] = ['detected', 'diagnosed', 'executing', 'paused'];

export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; cause?: string }>;
}) {
  const params = await searchParams;
  const db = getDb();
  const selection = await selectMerchant(db);
  const merchant = selection ? await getMerchant(db, selection.current.id) : null;

  if (!merchant) {
    return <Empty title="No merchant connected" body="Run npm run seed:demo to load sample data." />;
  }

  const filter = params.state ?? 'open';
  const stateFilter: CaseState[] | undefined =
    filter === 'open'
      ? LIVE
      : filter === 'recovered'
        ? ['recovered']
        : filter === 'lost'
          ? ['lost']
          : undefined;

  const [cases, causes] = await Promise.all([
    getRecentCases(db, merchant.id, {
      limit: 200,
      ...(stateFilter ? { state: stateFilter } : {}),
      ...(params.cause ? { causeClass: params.cause } : {}),
    }),
    // The chip list only samples recent activity to suggest filters — it isn't
    // itself a date filter, so a fixed 30-day window is fine here.
    getCauseClassBreakdown(db, merchant.id, resolveDateRange({}).range),
  ]);

  const total = cases.reduce((sum, c) => sum + c.amountPaise, 0);

  const href = (next: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = { state: params.state, cause: params.cause, ...next };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `/cases?${s}` : '/cases';
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{merchant.name}</div>
          <h1>Cases</h1>
        </div>
        <div className="subtle" style={{ textAlign: 'right' }}>
          {cases.length} shown
          <br />
          <span className="muted">{inr(total)} in view</span>
        </div>
      </div>

      {/* One filter row above everything it scopes — never inside a card. */}
      <div className="toolbar">
        {[
          ['open', 'Open'],
          ['recovered', 'Recovered'],
          ['lost', 'Written off'],
          ['all', 'All'],
        ].map(([key, label]) => (
          <Link
            key={key}
            href={href({ state: key })}
            className="chip"
            // Compared against the RESOLVED filter, not the raw param. Deriving
            // it from `!params.state` as well would light up both "Open" and
            // "All" on the default view, since open IS the default.
            aria-pressed={filter === key}
          >
            {label}
          </Link>
        ))}

        <span style={{ width: 8 }} />

        {causes.slice(0, 5).map((c) => (
          <Link
            key={c.causeClass}
            href={href({ cause: params.cause === c.causeClass ? undefined : c.causeClass })}
            className="chip"
            aria-pressed={params.cause === c.causeClass}
          >
            {causeLabel(c.causeClass)}
          </Link>
        ))}
      </div>

      {cases.length === 0 ? (
        <Empty
          title="Nothing matches"
          body="No cases match this filter. Try widening it, or check back once more failures arrive."
        />
      ) : (
        <div className="panel">
          {/* Capped and scrolled inside itself: 200 cases is a normal filter
              result here, and letting the page grow to fit them all is what
              made this view feel unbounded. */}
          <div className="table-wrap panel-scroll">
            <table className="data data-cases">
              <thead>
                <tr>
                  <th>Cause</th>
                  <th>Reason</th>
                  <th>Method</th>
                  <th>Customer</th>
                  <th>State</th>
                  <th>Group</th>
                  <th className="num">Amount</th>
                  <th>Opened</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/cases/${c.id}`} className="row-link" style={{ fontWeight: 500 }}>
                        {causeLabel(c.causeClass)}
                      </Link>
                    </td>
                    <td className="mono muted">{c.errorReason}</td>
                    <td>
                      {c.method}
                      {c.bank ? <span className="muted"> · {c.bank}</span> : null}
                    </td>
                    <td className="muted mono">{c.customerContact ?? '—'}</td>
                    <td>
                      <StatePill state={c.state} />
                    </td>
                    <td className="muted">
                      {c.cohort === 'holdout' ? 'Holdout' : 'Treatment'}
                    </td>
                    <td className="num">{inr(c.amountPaise)}</td>
                    <td className="muted">{relativeTime(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* The vocabulary lives in the docked key, bottom-right — a reference to
          open when a word is unfamiliar, rather than a paragraph everyone
          scrolls past exactly once. */}
      <CasesLegend />
    </>
  );
}
