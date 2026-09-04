import Link from 'next/link';

import { getDb } from '../../db/client';
import {
  getCauseClassBreakdown,
  getDailyTrend,
  getMerchant,
  getMethodBankHeatmap,
  getOpenAlerts,
  getRecentCases,
  getRevenueAtRisk,
  getTopReasons,
} from '../../db/queries/dashboard';
import { Bars, Empty, Heatmap, Trend } from '../../components/charts';
import { Alert, Delta, Stat, StatePill, causeHint, causeLabel, inr, relativeTime } from '../../components/ui';
import { DateRangeFilter } from '../../components/date-range-filter';
import { SendModeSwitch } from '../../components/send-mode-switch';
import { resolveDateRange } from '../../lib/date-range';
import { selectMerchant } from '../../lib/merchant-context';

// Every figure is live. A cached dashboard that quietly shows yesterday's
// exposure is worse than no dashboard.
export const dynamic = 'force-dynamic';

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const resolved = resolveDateRange(params);
  const db = getDb();
  const selection = await selectMerchant(db);
  const merchant = selection ? await getMerchant(db, selection.current.id) : null;

  if (!merchant) {
    return (
      <>
        <div className="page-head">
          <div>
            <div className="eyebrow">Overview</div>
            <h1>Revenue at risk</h1>
          </div>
        </div>
        <Empty
          title="No merchant connected"
          body="Run npm run seed:demo to load a realistic sample account, or connect a Razorpay account to start ingesting live failures."
        />
      </>
    );
  }

  const [risk, causes, trend, heat, alerts, cases, reasons] = await Promise.all([
    getRevenueAtRisk(db, merchant.id, resolved.range),
    getCauseClassBreakdown(db, merchant.id, resolved.range),
    getDailyTrend(db, merchant.id, resolved.range),
    getMethodBankHeatmap(db, merchant.id, resolved.range),
    getOpenAlerts(db, merchant.id),
    getRecentCases(db, merchant.id, { limit: 8 }),
    getTopReasons(db, merchant.id, resolved.range, 6),
  ]);

  const resolvedCount = risk.recoveredCases + risk.lostCases;
  const recoveryRate = resolvedCount > 0 ? (risk.recoveredCases / resolvedCount) * 100 : null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{merchant.name}</div>
          <h1>Revenue at risk</h1>
        </div>
        <div className="page-head-controls">
          {/*
            The send switch lives here, not on an agent's page.
            `merchants.execution_enabled` gates the failed-payment ladder, the
            abandoned-cart agent and the discount caller alike, so the account-
            level page is where it belongs. It was on `/recovery` for historical
            reasons and read there as that one agent's control.
          */}
          <SendModeSwitch
            executionEnabled={merchant.executionEnabled}
            routing={{
              whatsappRedirectTo: merchant.whatsappRedirectTo,
              emailRedirectTo: merchant.emailRedirectTo,
            }}
          />
          <DateRangeFilter
            key={resolved.preset ?? `${resolved.customFrom}_${resolved.customTo}`}
            preset={resolved.preset}
            customFrom={resolved.customFrom}
            customTo={resolved.customTo}
          />
          <div className="subtle" style={{ textAlign: 'right' }}>
            {resolved.label}
          </div>
        </div>
      </div>

      {/* The hero figure — exactly one per view. */}
      <section className="hero">
        <div className="hero-label">Currently unrecovered</div>
        <div className="hero-value">{inr(risk.atRiskPaise)}</div>
        <div className="hero-meta">
          <Delta pct={risk.deltaPct} />
          <span className="muted" style={{ fontSize: 13 }}>
            across {risk.atRiskCases.toLocaleString('en-IN')} open case
            {risk.atRiskCases === 1 ? '' : 's'} · {risk.customersAffected.toLocaleString('en-IN')}{' '}
            customer{risk.customersAffected === 1 ? '' : 's'}
          </span>
        </div>
      </section>

      <div className="grid grid-4">
        <Stat
          label="Recovered"
          value={inr(risk.recoveredPaise)}
          foot={`${risk.recoveredCases} case${risk.recoveredCases === 1 ? '' : 's'}`}
        />
        <Stat
          label="Recovery rate"
          value={recoveryRate == null ? '—' : `${recoveryRate.toFixed(0)}%`}
          foot={resolvedCount > 0 ? `of ${resolvedCount} resolved` : 'nothing resolved yet'}
        />
        <Stat
          label="Written off"
          value={inr(risk.lostPaise)}
          foot={`${risk.lostCases} case${risk.lostCases === 1 ? '' : 's'} past deadline`}
        />
        <Stat
          label="Failure classes"
          value={String(causes.length)}
          foot={causes[0] ? `led by ${causeLabel(causes[0].causeClass).toLowerCase()}` : '—'}
        />
      </div>

      {alerts.length > 0 && (
        <section className="section">
          <div className="card-head">
            <h2>Needs your attention</h2>
            <span className="card-sub">
              Diagnostic only — we state what broke and when, not what to switch off
            </span>
          </div>
          <div className="stack">
            {alerts.map((a) => (
              <Alert
                key={a.id}
                severity={a.severity}
                title={a.title}
                body={a.detail}
                meta={
                  <>
                    <span>{a.affectedCases} affected</span>
                    <span>{inr(a.amountPaise)} at risk</span>
                    <span>started {relativeTime(a.onsetAt)}</span>
                  </>
                }
              />
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="card">
          <div className="card-head">
            <h2>Exposure over time</h2>
            <span className="card-sub">Value of cases opened each day</span>
          </div>
          <Trend
            data={trend.map((t) => ({ date: t.date, value: t.atRiskPaise, cases: t.cases }))}
          />
        </div>
      </section>

      <section className="section grid grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Where the money is going</h2>
            <span className="card-sub">By root cause</span>
          </div>
          <Bars
            emptyLabel="No classified failures in this window."
            data={causes.map((c) => ({
              key: c.causeClass,
              label: causeLabel(c.causeClass),
              value: c.amountPaise,
            }))}
          />
          {causes[0] && (
            <p className="subtle" style={{ marginTop: 18, fontSize: 12.5 }}>
              <strong style={{ fontWeight: 550 }}>{causeLabel(causes[0].causeClass)}</strong> is
              your largest exposure. {causeHint(causes[0].causeClass)}
            </p>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Top failure reasons</h2>
            <span className="card-sub">Ranked by value, not frequency</span>
          </div>
          <Bars
            emptyLabel="No failures recorded in this window."
            data={reasons.map((r) => ({
              key: r.errorReason,
              label: r.errorReason.replace(/_/g, ' '),
              value: r.amountPaise,
            }))}
          />
        </div>
      </section>

      <section className="section">
        <div className="card">
          <div className="card-head">
            <h2>Method and bank</h2>
            <span className="card-sub">A hot row is a rail worth investigating</span>
          </div>
          <Heatmap
            data={heat.map((h) => ({
              row: h.method,
              col: h.bank,
              value: h.amountPaise,
              cases: h.cases,
            }))}
          />
        </div>
      </section>

      <section className="section">
        <div className="card">
          <div className="card-head">
            <h2>Recent cases</h2>
            <Link href="/cases" className="card-sub" style={{ color: 'var(--data)' }}>
              View all →
            </Link>
          </div>
          {cases.length === 0 ? (
            <Empty title="No cases yet" body="Failures will appear here as they arrive." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Cause</th>
                    <th>Reason</th>
                    <th>Method</th>
                    <th>State</th>
                    <th className="num">Amount</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {cases.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/cases/${c.id}`} className="row-link">
                          {causeLabel(c.causeClass)}
                        </Link>
                      </td>
                      <td className="mono muted">{c.errorReason}</td>
                      <td>
                        {c.method}
                        {c.bank ? <span className="muted"> · {c.bank}</span> : null}
                      </td>
                      <td>
                        <StatePill state={c.state} />
                      </td>
                      <td className="num">{inr(c.amountPaise)}</td>
                      <td className="muted">{relativeTime(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
