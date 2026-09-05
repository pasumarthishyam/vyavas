import Link from 'next/link';

import { getDb } from '../../db/client';
import {
  getCauseClassBreakdown,
  getDailyTrend,
  getMerchant,
  getMethodBankHeatmap,
  getOpenAlerts,
  getRecentCases,
  getRecoveryOverview,
  getTopReasons,
  type RecoveryOverview,
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

  const [overview, causes, trend, heat, alerts, cases, reasons] = await Promise.all([
    getRecoveryOverview(db, merchant.id, resolved.range),
    getCauseClassBreakdown(db, merchant.id, resolved.range),
    getDailyTrend(db, merchant.id, resolved.range),
    getMethodBankHeatmap(db, merchant.id, resolved.range),
    getOpenAlerts(db, merchant.id),
    getRecentCases(db, merchant.id, { limit: 8 }),
    getTopReasons(db, merchant.id, resolved.range, 6),
  ]);

  const resolvedCount = overview.totalRecoveredCases + overview.totalWrittenOffCases;
  const recoveryRate = resolvedCount > 0 ? (overview.totalRecoveredCases / resolvedCount) * 100 : null;

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

      {/* The hero figure — exactly one per view, and now the sum of every
          agent's own exposure rather than the ladder's alone. */}
      <section className="hero">
        <div className="hero-label">Currently unrecovered — every agent</div>
        <div className="hero-value">{inr(overview.totalAtRiskPaise)}</div>
        <div className="hero-meta">
          <Delta pct={overview.deltaPct} />
          <span className="muted" style={{ fontSize: 13 }}>
            across {overview.totalAtRiskCases.toLocaleString('en-IN')} open case
            {overview.totalAtRiskCases === 1 ? '' : 's'} · {overview.customersAffected.toLocaleString('en-IN')}{' '}
            customer{overview.customersAffected === 1 ? '' : 's'} on a failed payment
          </span>
        </div>
      </section>

      <div className="grid grid-4">
        <Stat
          label="Recovered"
          value={inr(overview.totalRecoveredPaise)}
          foot={`${overview.totalRecoveredCases} case${overview.totalRecoveredCases === 1 ? '' : 's'} · every agent`}
        />
        <Stat
          label="Recovery rate"
          value={recoveryRate == null ? '—' : `${recoveryRate.toFixed(0)}%`}
          foot={resolvedCount > 0 ? `of ${resolvedCount} resolved` : 'nothing resolved yet'}
        />
        <Stat
          label="Written off"
          value={inr(overview.totalWrittenOffPaise)}
          foot={`${overview.totalWrittenOffCases} case${overview.totalWrittenOffCases === 1 ? '' : 's'} unpaid`}
        />
        <Stat
          label="Failure classes"
          value={String(causes.length)}
          foot={causes[0] ? `led by ${causeLabel(causes[0].causeClass).toLowerCase()}` : '—'}
        />
      </div>

      <section className="section">
        <div className="card-head">
          <h2>Recovered by agent</h2>
          <span className="card-sub">What each one is holding, and what it has closed</span>
        </div>
        <AgentBreakdown overview={overview} />
      </section>

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

      {/*
        Everything below is the failed-payment ladder's own detail: cause,
        reason, method, bank — none of it applies to a cart that never reached
        Razorpay, or to a call placed on a case already counted above. The
        Abandoned Cart and Discount Caller agents each have this same depth of
        detail on their own pages; repeating it here would triple the page
        without adding a fact this one didn't already have.
      */}
      <div className="section-divider">
        <span>Failed-payment detail</span>
      </div>

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

/* ── recovered by agent ───────────────────────────────────────────────────── */

/**
 * Three agents, three cards, one shared shape: an icon and a name up top, then
 * a row of plain label/value pairs rather than nested `.stat` tiles — a card
 * inside a card reads as clutter at this size, and these numbers are meant to
 * be scanned across the row, not admired individually.
 *
 * Icons stay in the ink scale rather than each getting its own hue. This
 * product reserves colour for magnitude and status everywhere else (see the
 * header comment on `globals.css`), and three arbitrary brand colours here
 * would be the one place that rule quietly broke.
 */
function AgentBreakdown({ overview }: { overview: RecoveryOverview }) {
  const fp = overview.failedPayment;
  const dc = overview.discountCaller;
  const ac = overview.abandonedCart;

  return (
    <div className="grid grid-3">
      <AgentCard
        icon={<RecoveryIcon />}
        name="Failed Payment Agent"
        href="/recovery"
        metrics={[
          { label: 'At risk', value: inr(fp.atRiskPaise), foot: `${fp.atRiskCount} open` },
          { label: 'Recovered', value: inr(fp.recoveredPaise), foot: `${fp.recoveredCount} case${fp.recoveredCount === 1 ? '' : 's'}` },
        ]}
        note={fp.writtenOffCount > 0 ? `${inr(fp.writtenOffPaise)} written off · ${fp.writtenOffCount} case${fp.writtenOffCount === 1 ? '' : 's'}` : undefined}
      />

      <AgentCard
        icon={<PhoneIcon />}
        name="Discount Caller Agent"
        href="/agents/discount-caller"
        metrics={[
          { label: 'Recovered by call', value: inr(dc.recoveredPaise), foot: `${dc.recoveredCount} case${dc.recoveredCount === 1 ? '' : 's'}` },
          { label: 'Calls placed', value: dc.callsPlaced.toLocaleString('en-IN'), foot: resolved(dc.callsPlaced) },
        ]}
        note="Dials cases already counted under Failed Payment Agent — not a separate pool of money."
      />

      <AgentCard
        icon={<CartIcon />}
        name="Abandoned Cart Agent"
        href="/agents/abandoned-cart"
        metrics={[
          { label: 'At risk', value: inr(ac.atRiskPaise), foot: `${ac.atRiskCount} open` },
          { label: 'Recovered', value: inr(ac.recoveredPaise), foot: `${ac.recoveredCount} cart${ac.recoveredCount === 1 ? '' : 's'}` },
        ]}
        note={ac.writtenOffCount > 0 ? `${inr(ac.writtenOffPaise)} expired unpaid · ${ac.writtenOffCount} cart${ac.writtenOffCount === 1 ? '' : 's'}` : undefined}
      />
    </div>
  );
}

const resolved = (n: number) => (n > 0 ? 'this window' : 'none yet');

interface AgentMetric {
  label: string;
  value: string;
  foot: string;
}

function AgentCard({
  icon,
  name,
  href,
  metrics,
  note,
}: {
  icon: React.ReactNode;
  name: string;
  href: string;
  metrics: [AgentMetric, AgentMetric];
  note?: string;
}) {
  return (
    <div className="agent-card">
      <div className="agent-card-head">
        <span className="agent-card-icon">{icon}</span>
        <span className="agent-card-name">{name}</span>
        <Link href={href} className="agent-card-link" aria-label={`Open ${name}`}>
          <ArrowIcon />
        </Link>
      </div>

      <div className="agent-card-metrics">
        {metrics.map((m) => (
          <div className="agent-metric" key={m.label}>
            <div className="agent-metric-label">{m.label}</div>
            <div className="agent-metric-value">{m.value}</div>
            <div className="agent-metric-foot">{m.foot}</div>
          </div>
        ))}
      </div>

      {note && <p className="agent-card-note">{note}</p>}
    </div>
  );
}

/* ── icons, in the ink scale — see the note on `AgentBreakdown` ── */

function RecoveryIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.7-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M12.2 1.9v2.4H9.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 2.5h2l1 3-1.5 1.2a8 8 0 0 0 4.3 4.3L10.5 9.5l3 1v2a1 1 0 0 1-1.1 1C7.3 13 3 8.7 2.5 3.6a1 1 0 0 1 1-1.1Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CartIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.8 2h1.4l1 8.2a1.4 1.4 0 0 0 1.4 1.2h5.6a1.4 1.4 0 0 0 1.4-1.1l1-5.4H4.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="6.2" cy="14" r="1" fill="currentColor" />
      <circle cx="11" cy="14" r="1" fill="currentColor" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 8h8M8.5 4.5 12 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
