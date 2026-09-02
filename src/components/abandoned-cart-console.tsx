'use client';

import { useCallback, useEffect, useState } from 'react';

import { inr, relativeTime } from './ui';
import type { AbandonedCartRow } from '../db/queries/abandoned-cart-agent';

/**
 * The cart history table and its own status sync.
 *
 * Just the monitoring surface now — the integration box lives in its own
 * `AbandonedCartIntegrationCard` (a fixed-width aside, not part of this flow),
 * and the manual test-send action was removed once end-to-end testing was
 * done; the exact pipeline it exercised is still the one the real webhook
 * runs, so there was nothing left for it to prove.
 */
export function AbandonedCartConsole({ carts: initialCarts }: { carts: AbandonedCartRow[] }) {
  const [carts, setCarts] = useState(initialCarts);
  const [syncing, setSyncing] = useState(false);

  const hasPending = carts.some((c) => c.status === 'detected' || c.status === 'emailed');

  const refreshCarts = useCallback(async () => {
    const res = await fetch('/api/abandoned-cart/list', { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) return;
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; carts?: AbandonedCartRow[] };
    if (json.ok && json.carts) setCarts(json.carts);
  }, []);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      await fetch('/api/abandoned-cart/sync', { method: 'POST' });
      await refreshCarts();
    } catch {
      // The table keeps showing whatever it last knew — not worse than
      // before, and the button is right there to try again.
    } finally {
      setSyncing(false);
    }
  }, [refreshCarts]);

  useEffect(() => {
    if (!hasPending) return;
    const id = setInterval(() => void sync(), 15_000);
    return () => clearInterval(id);
  }, [hasPending, sync]);

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="panel-head">
        <span className="panel-title">Cart activity</span>
        <button type="button" className="btn-ghost" disabled={syncing} onClick={() => void sync()}>
          {syncing ? 'Syncing…' : 'Sync status'}
        </button>
      </div>
      {carts.length === 0 ? (
        <p className="subtle" style={{ padding: '16px 20px' }}>
          No abandoned carts reported yet — once your application calls the webhook, they&apos;ll show up here.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Customer</th>
                <th>Discount</th>
                <th>Link</th>
                <th>Reported</th>
              </tr>
            </thead>
            <tbody>
              {carts.map((c) => (
                <tr key={c.id}>
                  <td className="num">{inr(c.amountPaise)}</td>
                  <td>
                    <StatusCell status={c.status} reason={c.failureReason} />
                  </td>
                  <td>
                    <div className="cell-main">{c.customerName ?? '—'}</div>
                    <div className="cell-sub mono">{c.customerEmail}</div>
                  </td>
                  <td className="muted">{c.discountAmountPaise ? inr(c.discountAmountPaise) : '—'}</td>
                  <td>
                    {c.paymentLinkUrl ? (
                      <a href={c.paymentLinkUrl} target="_blank" rel="noreferrer" className="mono">
                        {inr(c.paymentLinkAmountPaise ?? 0)}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="muted nowrap">{relativeTime(new Date(c.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusCell({ status, reason }: { status: string; reason: string | null }) {
  const isFailure = status === 'failed';
  return (
    <span className="pill" title={reason ?? undefined}>
      <span
        className="dot"
        style={{
          background: isFailure
            ? 'var(--critical)'
            : status === 'recovered'
              ? 'var(--good)'
              : status === 'expired'
                ? 'var(--ink-muted)'
                : status === 'detected'
                  ? 'var(--ink-muted)'
                  : 'var(--data)',
        }}
      />
      {status}
      {isFailure && reason ? <span className="cell-sub"> · {reason}</span> : null}
    </span>
  );
}
