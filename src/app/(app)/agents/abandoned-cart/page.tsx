import { getDb } from '../../../../db/client';
import { selectMerchant } from '../../../../lib/merchant-context';
import { getMerchant } from '../../../../db/queries/dashboard';
import {
  getAbandonedCartSummary,
  getRecentAbandonedCarts,
} from '../../../../db/queries/abandoned-cart-agent';
import { getAbandonedCartApiKey } from '../../../../db/repos/abandoned-cart-auth';
import { appUrl } from '../../../../lib/env';
import { resolveDateRange } from '../../../../lib/date-range';
import { Empty } from '../../../../components/charts';
import { Alert, Delta, Stat, inr } from '../../../../components/ui';
import { DateRangeFilter } from '../../../../components/date-range-filter';
import { AbandonedCartConsole } from '../../../../components/abandoned-cart-console';
import { AbandonedCartIntegrationCard } from '../../../../components/abandoned-cart-integration-card';

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
  const mode = merchant.executionEnabled ? 'live' : 'paused';
  const emailDiverted = Boolean(merchant.emailRedirectTo);
  const MODE_COPY = {
    paused: {
      label: 'Paused',
      hint: 'Carts are recorded, nothing is emailed',
      dot: 'var(--ink-muted)',
    },
    live: {
      label: 'Live',
      // The hint used to promise "email only" whatever the routing said, which
      // read as "the customer gets an email" on an account where every message
      // is diverted to a test inbox. Same fix as the status column below: say
      // where it actually goes.
      hint: emailDiverted ? '₹200 off, 24h link, email diverted' : '₹200 off, 24h link, email only',
      dot: emailDiverted ? 'var(--warning)' : 'var(--good)',
    },
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

      {/* Where email on this account actually goes. The same banner `/recovery`
          carries, for the same reason: every "sent" below means nothing until
          you know whether it went to the customer or to a test inbox. */}
      <div className={`notice${mode === 'live' && !emailDiverted ? ' notice-critical' : ''}`}>
        <InfoIcon />
        <span>
          <strong style={{ fontWeight: 550 }}>Email</strong>{' '}
          {mode !== 'live' ? (
            <>
              is not being sent — this account is <strong style={{ fontWeight: 550 }}>paused</strong>
              . Carts are still recorded.
            </>
          ) : emailDiverted ? (
            <>
              → <span className="mono">{merchant.emailRedirectTo}</span>, never the customer.
            </>
          ) : (
            <>
              → the <strong style={{ fontWeight: 550 }}>real customer address</strong>
              {merchant.emailFrom ? (
                <>
                  {' '}
                  from <span className="mono">{merchant.emailFrom}</span>
                </>
              ) : null}
              . Real people receive these.
            </>
          )}
        </span>
      </div>

      {mode !== 'live' && (
        <div className="notice">
          <InfoIcon />
          <span>
            Paused, so a cart reported now is recorded and left alone — and unlike a recovery case,
            it is <strong style={{ fontWeight: 550 }}>not picked up again</strong> when you switch to
            Live. Emailing someone about a cart they abandoned days ago is worse than not emailing
            them. Re-post the same <span className="mono">cartId</span> to process it.
          </span>
        </div>
      )}

      {summary.failedCount > 0 && (
        <div style={{ marginBottom: 20 }}>
          <Alert
            severity="warning"
            title={`${summary.failedCount} cart${summary.failedCount === 1 ? '' : 's'} failed to process`}
            body="Never got as far as a payment link — usually a missing payment provider or an amount too small once the discount applied. The reason for each is on its row below."
          />
        </div>
      )}

      {summary.notDeliveredCount > 0 && (
        <div style={{ marginBottom: 20 }}>
          <Alert
            severity="warning"
            title={`${summary.notDeliveredCount} cart${summary.notDeliveredCount === 1 ? ' has' : 's have'} a live payment link nobody was told about`}
            body="The link was created but the email did not go out — a customer already at their daily message limit, an address the provider rejected, or no email channel on this account. The Email column says which, per cart."
          />
        </div>
      )}

      <AbandonedCartConsole
        carts={carts}
        paused={mode !== 'live'}
        emailRedirectTo={merchant.emailRedirectTo}
      />

      {/* Setup, folded away. It used to be a 300px sticky aside beside the
          metrics, which is where the page's horizontal overflow came from —
          a bearer token and a full webhook URL do not fit in 300px. */}
      <AbandonedCartIntegrationCard endpoint={endpoint} apiKey={apiKey} />
    </>
  );
}

/** Same glyph the recovery console's notices use — copied rather than imported
 *  so this server component does not pull a client module in for an svg. */
function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 7.2v4M8 4.9h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
