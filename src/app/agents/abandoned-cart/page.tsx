import { getDb } from '../../../db/client';
import { selectMerchant } from '../../../lib/merchant-context';
import { getMerchant } from '../../../db/queries/dashboard';
import {
  getAbandonedCartDailyTrend,
  getAbandonedCartSummary,
  getRecentAbandonedCarts,
} from '../../../db/queries/abandoned-cart-agent';
import { getAbandonedCartApiKey } from '../../../db/repos/abandoned-cart-auth';
import { appUrl } from '../../../lib/env';
import { resolveDateRange } from '../../../lib/date-range';
import { Empty, Trend } from '../../../components/charts';
import { Alert, Delta, Stat, inr } from '../../../components/ui';
import { DateRangeFilter } from '../../../components/date-range-filter';
import { AbandonedCartConsole } from '../../../components/abandoned-cart-console';
import { AbandonedCartIntegrationCard } from '../../../components/abandoned-cart-integration-card';

export const dynamic = 'force-dynamic';

/**
 * The abandoned-cart agent's own page.
 *
 * Deliberately not part of `/recovery`, `/cases`, or `/agents/discount-caller`
 * — this agent has no `recovery_cases` row underneath it at all (Razorpay has
 * nothing to report on a cart nobody ever tried to pay for), and it learns a
 * cart exists only because the merchant's OWN application tells it to, via the
 * webhook `AbandonedCartIntegrationCard` issues a key for. See
 * `db/schema/abandoned-cart.ts`.
 *
 * Laid out the same way `/` is — a hero figure, a stat grid, a trend, a
 * table — for the same reason: it is the one layout in this product that
 * already reads as "a human can monitor this at a glance," and a second
 * agent reinventing its own dashboard language would cost that, not add to it.
 */
export default async function AbandonedCartPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const resolved = resolveDateRange(params);
  const db = getDb();
  const selection = await selectMerchant(db);

  if (!selection) {
    return <Empty title="No merchant connected" body="Run npm run seed:demo to load sample data." />;
  }

  const merchant = await getMerchant(db, selection.current.id);
  if (!merchant) {
    return <Empty title="No merchant connected" body="Run npm run seed:demo to load sample data." />;
  }

  const [summary, trend, carts, apiKey] = await Promise.all([
    getAbandonedCartSummary(db, merchant.id, resolved.range),
    getAbandonedCartDailyTrend(db, merchant.id, resolved.range),
    getRecentAbandonedCarts(db, merchant.id, 50),
    getAbandonedCartApiKey(db, merchant.id),
  ]);

  const endpoint = `${appUrl().replace(/\/$/, '')}/api/abandoned-cart/${merchant.slug}/webhook`;

  const resolvedCount = summary.recoveredCount + summary.expiredCount;
  const recoveryRate = resolvedCount > 0 ? (summary.recoveredCount / resolvedCount) * 100 : null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{merchant.name}</div>
          <h1>Abandoned Cart Agent</h1>
        </div>
        <div className="page-head-controls">
          <DateRangeFilter
            key={resolved.preset ?? `${resolved.customFrom}_${resolved.customTo}`}
            preset={resolved.preset}
            customFrom={resolved.customFrom}
            customTo={resolved.customTo}
          />
          <div className="subtle" style={{ textAlign: 'right' }}>
            {resolved.label}
            <br />
            <span className="muted">
              {!merchant.executionEnabled
                ? 'Execution is OFF — carts are recorded, nothing is emailed'
                : merchant.dryRun
                  ? 'Dry-run — links are created, nothing is emailed'
                  : 'Live — ₹200 off, 24h link, email only'}
            </span>
          </div>
        </div>
      </div>

      <div className="with-aside">
        <div>
          <section className="hero">
            <div className="hero-label">Currently at risk in abandoned carts</div>
            <div className="hero-value">{inr(summary.atRiskPaise)}</div>
            <div className="hero-meta">
              <Delta pct={summary.deltaPct} />
              <span className="muted" style={{ fontSize: 13 }}>
                {summary.atRiskCount.toLocaleString('en-IN')} open cart{summary.atRiskCount === 1 ? '' : 's'} ·{' '}
                {summary.customersReached.toLocaleString('en-IN')} customer{summary.customersReached === 1 ? '' : 's'} reached
              </span>
            </div>
          </section>

          <div className="grid grid-4">
            <Stat
              label="Recovered"
              value={inr(summary.recoveredPaise)}
              foot={`${summary.recoveredCount} cart${summary.recoveredCount === 1 ? '' : 's'}`}
            />
            <Stat
              label="Recovery rate"
              value={recoveryRate == null ? '—' : `${recoveryRate.toFixed(0)}%`}
              foot={resolvedCount > 0 ? `of ${resolvedCount} resolved` : 'nothing resolved yet'}
            />
            <Stat
              label="Expired unpaid"
              value={inr(summary.expiredPaise)}
              foot={`${summary.expiredCount} link${summary.expiredCount === 1 ? '' : 's'} past 24h`}
            />
            <Stat
              label="Carts reported"
              value={summary.totalCount.toLocaleString('en-IN')}
              foot={resolved.label.toLowerCase()}
            />
          </div>

          {summary.failedCount > 0 && (
            <section className="section">
              <Alert
                severity="warning"
                title={`${summary.failedCount} cart${summary.failedCount === 1 ? '' : 's'} failed to process`}
                body="Never got as far as a payment link — usually a missing payment provider or an amount too small once the discount applied. Check the table below for the reason on each."
              />
            </section>
          )}

          <section className="section">
            <div className="card">
              <div className="card-head">
                <h2>Cart value over time</h2>
                <span className="card-sub">Reported each day, whatever happened to it since</span>
              </div>
              <Trend data={trend.map((t) => ({ date: t.date, value: t.amountPaise, cases: t.count }))} />
            </div>
          </section>

          <section className="section">
            <AbandonedCartConsole carts={carts} />
          </section>
        </div>

        <AbandonedCartIntegrationCard endpoint={endpoint} apiKey={apiKey} />
      </div>
    </>
  );
}
