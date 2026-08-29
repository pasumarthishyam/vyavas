import { getDb } from '../../db/client';
import {
  getConsoleMerchant,
  getRecentActivity,
  getRecoverableCases,
  getRecoverySummary,
} from '../../db/queries/recovery';
import { RecoveryConsole } from '../../components/recovery-console';
import { Empty } from '../../components/charts';

/**
 * The recovery console.
 *
 * Server-rendered once with real data so the page is useful before any
 * JavaScript runs, then the client component takes over and polls. Without the
 * server pass the first paint is an empty shell for two and a half seconds,
 * which reads as broken.
 */
export const dynamic = 'force-dynamic';

export default async function RecoveryPage() {
  const db = getDb();
  const merchant = await getConsoleMerchant(db);

  if (!merchant) {
    return (
      <>
        <div className="page-head">
          <div>
            <div className="eyebrow">Recovery</div>
            <h1>Recovery</h1>
          </div>
        </div>
        <Empty
          title="No merchant connected"
          body="Connect a Razorpay account and run npm run backfill to pull in real failures."
        />
      </>
    );
  }

  const [cases, activity, summary] = await Promise.all([
    getRecoverableCases(db, merchant.id),
    getRecentActivity(db, merchant.id, 25),
    getRecoverySummary(db, merchant.id),
  ]);

  return (
    <RecoveryConsole
      initial={{ merchant, cases, activity, summary, now: new Date().toISOString() }}
    />
  );
}
