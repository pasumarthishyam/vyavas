import { getDb } from '../../../db/client';
import { selectMerchant } from '../../../lib/merchant-context';
import { getMerchant } from '../../../db/queries/dashboard';
import { getRecentAbandonedCarts } from '../../../db/queries/abandoned-cart-agent';
import { getAbandonedCartApiKey } from '../../../db/repos/abandoned-cart-auth';
import { appUrl } from '../../../lib/env';
import { Empty } from '../../../components/charts';
import { AbandonedCartConsole } from '../../../components/abandoned-cart-console';

export const dynamic = 'force-dynamic';

/**
 * The abandoned-cart agent's own page.
 *
 * Deliberately not part of `/recovery`, `/cases`, or `/agents/discount-caller`
 * — this agent has no `recovery_cases` row underneath it at all (Razorpay has
 * nothing to report on a cart nobody ever tried to pay for), and it learns a
 * cart exists only because the merchant's OWN application tells it to, via the
 * webhook this page issues a key for. See `db/schema/abandoned-cart.ts`.
 */
export default async function AbandonedCartPage() {
  const db = getDb();
  const selection = await selectMerchant(db);

  if (!selection) {
    return <Empty title="No merchant connected" body="Run npm run seed:demo to load sample data." />;
  }

  const merchant = await getMerchant(db, selection.current.id);
  if (!merchant) {
    return <Empty title="No merchant connected" body="Run npm run seed:demo to load sample data." />;
  }

  const [carts, apiKey] = await Promise.all([
    getRecentAbandonedCarts(db, merchant.id, 50),
    getAbandonedCartApiKey(db, merchant.id),
  ]);

  const endpoint = `${appUrl().replace(/\/$/, '')}/api/abandoned-cart/${merchant.slug}/webhook`;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{merchant.name}</div>
          <h1>Abandoned Cart Agent</h1>
        </div>
      </div>

      <div className="notice">
        <span>
          This agent never sees an abandoned cart on its own — Razorpay has nothing to report on a
          payment nobody attempted. It relies entirely on <strong style={{ fontWeight: 550 }}>your
          own application</strong> calling the webhook below when a customer leaves without paying.
          When it does, this agent emails them a fixed <strong style={{ fontWeight: 550 }}>₹200
          discount</strong> and a payment link valid for <strong style={{ fontWeight: 550 }}>24
          hours</strong> — nothing is called, and nothing is sent on any channel but email.
          {!merchant.executionEnabled ? (
            <>
              {' '}
              <strong style={{ fontWeight: 550, color: 'var(--warning)' }}>
                This merchant&apos;s master switch (execution) is currently OFF
              </strong>
              , so carts reported to the webhook are recorded but nothing is emailed until it&apos;s
              turned on.
            </>
          ) : merchant.dryRun ? (
            <>
              {' '}
              <strong style={{ fontWeight: 550, color: 'var(--warning)' }}>Dry-run is ON</strong> —
              a payment link is created but no email actually goes out; everything is logged as if it
              had.
            </>
          ) : null}
        </span>
      </div>

      <AbandonedCartConsole endpoint={endpoint} apiKey={apiKey} carts={carts} />
    </>
  );
}
