import { getDb } from '../../../db/client';
import { selectMerchant } from '../../../lib/merchant-context';
import { getMerchant } from '../../../db/queries/dashboard';
import { getCallableCases, getRecentVoiceCallRows } from '../../../db/queries/voice-agent';
import { Empty } from '../../../components/charts';
import { Stat, inr } from '../../../components/ui';
import { DiscountCallerConsole } from '../../../components/discount-caller-console';

export const dynamic = 'force-dynamic';

/**
 * The discount-calling agent's own page.
 *
 * Deliberately not part of `/recovery` or `/cases` — this agent can move a
 * price, which the failed-payment ladder never does, and it should never be
 * mistaken for a rung of that ladder.
 */
export default async function DiscountCallerPage() {
  const db = getDb();
  const selection = await selectMerchant(db);

  if (!selection) {
    return <Empty title="No merchant connected" body="Run npm run seed:demo to load sample data." />;
  }

  const merchant = await getMerchant(db, selection.current.id);
  if (!merchant) {
    return <Empty title="No merchant connected" body="Run npm run seed:demo to load sample data." />;
  }

  const [cases, calls] = await Promise.all([
    getCallableCases(db, merchant.id, 100),
    getRecentVoiceCallRows(db, merchant.id, 50),
  ]);

  const callableAtRisk = cases.reduce((sum, c) => sum + c.amountPaise, 0);
  const inFlight = calls.filter(
    (c) => c.status === 'queued' || c.status === 'ringing' || c.status === 'in_progress',
  ).length;
  const linked = calls.filter((c) => c.paymentLinkUrl != null).length;
  const paid = calls.filter((c) => c.paymentConfirmedAt != null);
  const paidCount = paid.length;
  const paidPaise = paid.reduce((sum, c) => sum + (c.paymentLinkAmountPaise ?? 0), 0);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{merchant.name}</div>
          <h1>Discount Caller Agent</h1>
        </div>
      </div>

      {/* Metrics before the lists, the same way every other agent page reads:
          what is available to call, and what calling has actually produced. */}
      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <Stat
          label="Callable now"
          value={inr(callableAtRisk)}
          foot={`${cases.length} case${cases.length === 1 ? '' : 's'} with a number on file`}
        />
        <Stat
          label="Calls placed"
          value={String(calls.length)}
          foot={inFlight > 0 ? `${inFlight} still in flight` : 'none in flight'}
        />
        <Stat
          label="Paid after a call"
          value={inr(paidPaise)}
          foot={`${paidCount} of ${linked} link${linked === 1 ? '' : 's'} sent`}
        />
      </div>

      <DiscountCallerConsole cases={cases} calls={calls} />

      <p className="subtle" style={{ marginTop: 20, fontSize: 12.5 }}>
        Discounts here are capped at <strong style={{ fontWeight: 550 }}>₹500 total</strong>, offered
        in ₹200 then ₹500 tiers, and are never offered on a case the taxonomy already marks as
        fraud-risk, already-paid, or a merchant-side fault.
      </p>
    </>
  );
}
