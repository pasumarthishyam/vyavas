import { getDb } from '../../../db/client';
import { selectMerchant } from '../../../lib/merchant-context';
import { getMerchant } from '../../../db/queries/dashboard';
import {
  getAbandonedCartSummary,
  getRecentAbandonedCarts,
} from '../../../db/queries/abandoned-cart-agent';
import { getAbandonedCartApiKey } from '../../../db/repos/abandoned-cart-auth';
import { appUrl } from '../../../lib/env';
import { resolveDateRange } from '../../../lib/date-range';
import { Empty } from '../../../components/charts';
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
 * ── why this stopped looking like the Overview page ──
 *
 * It was laid out as a dashboard: a 68px hero figure, then tiles, then a trend
 * chart, then the table. That is the right shape for `/` — a page you read to
 * form an impression — and the wrong one for an agent console, which is a page
 * you open to check whether the thing is working and what it just did. The hero
 * spent a third of the fold restating a number that is also the first tile, and
 * the trend charted a series that is, for most merchants, four points long.
 *
 * It reads like `/recovery` now, because that is the page with the same job:
 * a head, one row of metrics, then the activity itself, with setup folded away
 * at the bottom where a thing you do once belongs.
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

  const [summary, carts, apiKey] = await Promise.all([
    getAbandonedCartSummary(db, merchant.id, resolved.range),
    getRecentAbandonedCarts(db, merchant.id, 50),
    getAbandonedCartApiKey(db, merchant.id),
  ]);

  const endpoint = `${appUrl().replace(/\/$/, '')}/api/abandoned-cart/${merchant.slug}/webhook`;

  const resolvedCount = summary.recoveredCount + summary.expiredCount;
  const recoveryRate = resolvedCount > 0 ? (summary.recoveredCount / resolvedCount) * 100 : null;

  // Read-only, unlike `/recovery`'s switch: this agent's send mode is the
  // merchant's, set there. Shown in the same box so the two pages agree about
  // what "Live" looks like.
  const mode = !merchant.executionEnabled ? 'off' : merchant.dryRun ? 'dry_run' : 'live';
  const MODE_COPY = {
    off: { label: 'Off', hint: 'Carts are recorded, nothing is emailed', dot: 'var(--ink-muted)' },
    dry_run: { label: 'Dry run', hint: 'Links are created, nothing is emailed', dot: 'var(--data)' },
    live: { label: 'Live', hint: '₹200 off, 24h link, email only', dot: 'var(--good)' },
  } as const;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{merchant.name}</div>
          <h1>Abandoned Cart Agent</h1>
        </div>
        <div className="page-head-controls">
          <div className="exec">
            <div className="exec-label">
              <span className="exec-title">{MODE_COPY[mode].label}</span>
              <span className="exec-sub">{MODE_COPY[mode].hint}</span>
            </div>
            <span className="pill">
              <span className="dot" style={{ background: MODE_COPY[mode].dot }} />
              {MODE_COPY[mode].label}
            </span>
          </div>
          <DateRangeFilter
            key={resolved.preset ?? `${resolved.customFrom}_${resolved.customTo}`}
            preset={resolved.preset}
            customFrom={resolved.customFrom}
            customTo={resolved.customTo}
          />
        </div>
      </div>

      {/* One row of metrics, same shape and same tile as the recovery console —
          money at risk first, because it is the only figure here that is a
          decision rather than a report. */}
      <div className="grid grid-4" style={{ marginBottom: 20 }}>
        <Stat
          label="At risk"
          value={inr(summary.atRiskPaise)}
          foot={`${summary.atRiskCount.toLocaleString('en-IN')} open cart${summary.atRiskCount === 1 ? '' : 's'}`}
        />
        <Stat
          label="Recovered"
          value={inr(summary.recoveredPaise)}
          foot={`${summary.recoveredCount} cart${summary.recoveredCount === 1 ? '' : 's'} paid`}
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
      </div>

      <div className="metrics-meta">
        <span>{resolved.label}</span>
        <span>
          {summary.totalCount.toLocaleString('en-IN')} cart
          {summary.totalCount === 1 ? '' : 's'} reported
        </span>
        <span>
          {summary.customersReached.toLocaleString('en-IN')} customer
          {summary.customersReached === 1 ? '' : 's'} reached
        </span>
        <Delta pct={summary.deltaPct} />
      </div>

      {summary.failedCount > 0 && (
        <div style={{ marginBottom: 20 }}>
          <Alert
            severity="warning"
            title={`${summary.failedCount} cart${summary.failedCount === 1 ? '' : 's'} failed to process`}
            body="Never got as far as a payment link — usually a missing payment provider or an amount too small once the discount applied. The reason for each is on its row below."
          />
        </div>
      )}

      <AbandonedCartConsole carts={carts} />

      {/* Setup, folded away. It used to be a 300px sticky aside beside the
          metrics, which is where the page's horizontal overflow came from —
          a bearer token and a full webhook URL do not fit in 300px. */}
      <AbandonedCartIntegrationCard endpoint={endpoint} apiKey={apiKey} />
    </>
  );
}
