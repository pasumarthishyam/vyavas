'use client';

import { useCallback, useEffect, useState } from 'react';

import { inr, relativeTime } from './ui';
import type { AbandonedCartRow } from '../db/queries/abandoned-cart-agent';
import { buildAiPrompt, buildCodeSnippet } from '../lib/abandoned-cart-integration';

type Tab = 'code' | 'prompt';

/**
 * The integration box, the test-send action, and the cart history — one
 * client component for the same reason `DiscountCallerConsole` is: the
 * history has to refresh itself, and the key shown in the integration box
 * changes the moment "Regenerate" is pressed, so both need to share state.
 */
export function AbandonedCartConsole({
  endpoint,
  apiKey: initialApiKey,
  carts: initialCarts,
}: {
  endpoint: string;
  apiKey: string | null;
  carts: AbandonedCartRow[];
}) {
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [tab, setTab] = useState<Tab>('code');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState<'code' | 'prompt' | 'key' | 'endpoint' | null>(null);

  const [testEmail, setTestEmail] = useState('');
  const [testAmount, setTestAmount] = useState('999');
  const [testBusy, setTestBusy] = useState(false);
  const [testNotice, setTestNotice] = useState<string | null>(null);

  const [carts, setCarts] = useState(initialCarts);
  const [syncing, setSyncing] = useState(false);

  const hasPending = carts.some((c) => c.status === 'detected' || c.status === 'emailed');

  const refreshCarts = useCallback(async () => {
    // No list endpoint of its own — the sync route already returns nothing to
    // render, so the simplest correct refresh is re-fetching via a full page
    // data reload is avoided by keeping this client-only: re-run the same
    // query the server used, through a tiny GET this component owns.
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

  async function regenerateKey() {
    setGenerating(true);
    try {
      const res = await fetch('/api/abandoned-cart/keys', { method: 'POST' });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; apiKey?: string };
      if (json.ok && json.apiKey) setApiKey(json.apiKey);
    } finally {
      setGenerating(false);
    }
  }

  async function copy(text: string, which: typeof copied) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1800);
    } catch {
      // A viewer that blocks clipboard access still has the raw text on
      // screen to select manually.
    }
  }

  async function sendTest() {
    setTestBusy(true);
    setTestNotice(null);
    try {
      const amountPaise = Math.round(Number(testAmount || '0') * 100);
      const res = await fetch('/api/abandoned-cart/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, amountPaise }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; emailed?: boolean };
      if (!res.ok || !json.ok) {
        setTestNotice(json.reason ?? 'Could not send the test email.');
      } else {
        setTestNotice(json.emailed ? `Sent to ${testEmail}.` : 'Processed, but the email did not send — check the merchant is not in dry-run.');
        await refreshCarts();
      }
    } catch (e) {
      setTestNotice(e instanceof Error ? e.message : 'Could not send the test email.');
    } finally {
      setTestBusy(false);
    }
  }

  const snippet = buildCodeSnippet({ endpoint, apiKey });
  const prompt = buildAiPrompt({ endpoint, apiKey });

  return (
    <>
      <section className="card">
        <div className="panel-head">
          <span className="panel-title">Connect your application</span>
        </div>

        <div style={{ padding: '0 20px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div className="subtle" style={{ marginBottom: 6 }}>Webhook endpoint</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code className="mono" style={codeChipStyle}>{endpoint}</code>
              <button type="button" className="btn-ghost btn-sm" onClick={() => void copy(endpoint, 'endpoint')}>
                {copied === 'endpoint' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div>
            <div className="subtle" style={{ marginBottom: 6 }}>API key</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {apiKey ? (
                <>
                  <code className="mono" style={codeChipStyle}>{apiKey}</code>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => void copy(apiKey, 'key')}>
                    {copied === 'key' ? 'Copied' : 'Copy'}
                  </button>
                </>
              ) : (
                <span className="subtle">No key generated yet.</span>
              )}
              <button type="button" className="btn-primary btn-sm" disabled={generating} onClick={() => void regenerateKey()}>
                {generating ? 'Generating…' : apiKey ? 'Regenerate key' : 'Generate key'}
              </button>
            </div>
            {apiKey ? (
              <div className="subtle" style={{ marginTop: 4, fontSize: 12 }}>
                Regenerating replaces this key immediately — any storefront still using the old one starts getting rejected.
              </div>
            ) : null}
          </div>

          <div>
            <div className="segmented" style={{ marginBottom: 10 }}>
              <button
                type="button"
                className={`segment ${tab === 'code' ? 'segment-on' : ''}`}
                onClick={() => setTab('code')}
              >
                Code
              </button>
              <button
                type="button"
                className={`segment ${tab === 'prompt' ? 'segment-on' : ''}`}
                onClick={() => setTab('prompt')}
              >
                Prompt for Cursor / Antigravity
              </button>
            </div>

            <div style={{ position: 'relative' }}>
              <pre className="mono" style={preStyle}>{tab === 'code' ? snippet : prompt}</pre>
              <button
                type="button"
                className="btn-ghost btn-sm"
                style={{ position: 'absolute', top: 8, right: 8 }}
                onClick={() => void copy(tab === 'code' ? snippet : prompt, tab)}
              >
                {copied === tab ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="subtle" style={{ marginTop: 6, fontSize: 12 }}>
              {tab === 'code'
                ? 'Paste this wherever your app already knows a cart is abandoned.'
                : 'Paste this into an AI coding tool in your own repo — it explains what a webhook call is, exactly when to fire it, and the exact request shape, so it does not have to guess.'}
            </div>
          </div>

          {!apiKey ? (
            <div className="notice" style={{ margin: 0 }}>
              <span>Generate a key above before using either box below — both already have it filled in once you do.</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="card" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Send yourself a test email</span>
        </div>
        <div style={{ padding: '0 20px 20px', display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 }}>
            <span className="subtle">Email</span>
            <input
              type="email"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              placeholder="you@example.com"
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 }}>
            <span className="subtle">Cart total (₹)</span>
            <input
              type="number"
              min="1"
              value={testAmount}
              onChange={(e) => setTestAmount(e.target.value)}
              style={{ ...inputStyle, width: 120 }}
            />
          </label>
          <button type="button" className="btn-primary btn-sm" disabled={testBusy || !testEmail} onClick={() => void sendTest()}>
            {testBusy ? 'Sending…' : 'Send test email'}
          </button>
          {testNotice ? <span className="subtle">{testNotice}</span> : null}
        </div>
        <div className="subtle" style={{ padding: '0 20px 16px', fontSize: 12 }}>
          Runs the exact same pipeline the real webhook uses — discount, payment link, email — with a
          synthetic cart id, so this never gets caught by the duplicate-cart guard.
        </div>
      </section>

      <section className="card" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Cart history</span>
          <button type="button" className="btn-ghost" disabled={syncing} onClick={() => void sync()}>
            {syncing ? 'Syncing…' : 'Sync status'}
          </button>
        </div>
        {carts.length === 0 ? (
          <p className="subtle" style={{ padding: '16px 20px' }}>
            No abandoned carts reported yet.
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
      </section>
    </>
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

const codeChipStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderRadius: 6,
  background: 'var(--surface-sunken)',
  border: '1px solid var(--hairline)',
  fontSize: 12.5,
  overflowX: 'auto',
  whiteSpace: 'nowrap',
  maxWidth: '100%',
};

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: '14px 44px 14px 14px',
  borderRadius: 8,
  background: 'var(--surface-sunken)',
  border: '1px solid var(--hairline)',
  fontSize: 12.5,
  lineHeight: 1.55,
  overflowX: 'auto',
  whiteSpace: 'pre',
};

const inputStyle: React.CSSProperties = {
  padding: '7px 10px',
  borderRadius: 7,
  border: '1px solid var(--hairline)',
  background: 'var(--surface)',
  fontSize: 13,
  minWidth: 220,
};
