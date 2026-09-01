import { getDb } from '../../../db/client';
import { selectMerchant } from '../../../lib/merchant-context';
import { getMerchant } from '../../../db/queries/dashboard';
import { getCallableCases, getRecentVoiceCallRows } from '../../../db/queries/voice-agent';
import { allowedTestNumbers, voiceAgentEnabled } from '../../../lib/env';
import { Empty } from '../../../components/charts';
import { inr, relativeTime } from '../../../components/ui';
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

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{merchant.name}</div>
          <h1>Discount Caller</h1>
        </div>
      </div>

      {!voiceAgentEnabled() && (
        <div className="notice">
          <span>
            <strong style={{ fontWeight: 550 }}>VOICE_AGENT_ENABLED is off.</strong> Every "Call now"
            button below will refuse until it's set to <span className="mono">true</span>.
          </span>
        </div>
      )}

      <div className="notice">
        <span>
          Calls are hard-limited to the numbers in{' '}
          <span className="mono">VOICE_AGENT_ALLOWED_TEST_NUMBERS</span>
          {allowedTestNumbers().length > 0 ? (
            <>
              {' '}
              — currently:{' '}
              {allowedTestNumbers().map((n) => (
                <span key={n} className="mono">
                  {n}{' '}
                </span>
              ))}
            </>
          ) : (
            <> — none configured, so no call can be placed yet.</>
          )}
        </span>
      </div>

      <DiscountCallerConsole cases={cases} calls={calls} />

      <section className="card" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Call history</span>
        </div>
        {calls.length === 0 ? (
          <p className="subtle" style={{ padding: '16px 20px' }}>
            No calls placed yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Phone</th>
                  <th>Status</th>
                  <th>Discount</th>
                  <th>Link</th>
                  <th>Paid</th>
                  <th>Placed</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id}>
                    <td className="mono muted">{c.customerPhone}</td>
                    <td>{c.status.replace(/_/g, ' ')}</td>
                    <td className="muted">
                      {c.discountAmountPaise ? `${inr(c.discountAmountPaise)} (tier ${c.discountTierOffered})` : '—'}
                    </td>
                    <td>
                      {c.paymentLinkUrl ? (
                        <a href={c.paymentLinkUrl} target="_blank" rel="noreferrer" className="mono">
                          {inr(c.paymentLinkAmountPaise ?? 0)}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{c.paymentConfirmedAt ? 'Yes' : c.paymentLinkUrl ? 'Not yet' : '—'}</td>
                    <td className="muted">{relativeTime(new Date(c.createdAt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="subtle" style={{ marginTop: 20, fontSize: 12.5 }}>
        Discounts here are capped at <strong style={{ fontWeight: 550 }}>₹500 total</strong>, offered
        in ₹200 then ₹500 tiers, and are never offered on a case the taxonomy already marks as
        fraud-risk, already-paid, or a merchant-side fault.
      </p>
    </>
  );
}
