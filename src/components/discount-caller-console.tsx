'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Vapi from '@vapi-ai/web';

import { causeLabel, inr, relativeTime } from './ui';
import type { CallableCase, VoiceCallRow } from '../db/queries/voice-agent';

type WebCallState = 'connecting' | 'active' | 'ended';

/** Vapi's SDK doesn't publicly document the shape it hands back here — read defensively. */
function extractCallId(value: unknown): string | null {
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown; call?: { id?: unknown } }).id ?? (value as { call?: { id?: unknown } }).call?.id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

/**
 * The "place a call" surface, and the call history behind it.
 *
 * Both live in one client component now — not for tidiness, but because the
 * history needs to update itself. Vapi's own webhook requires a Server URL
 * configured on the ASSISTANT (separate from the per-tool Server URL, and
 * easy to miss — it was missed here once already), so this cannot assume the
 * webhook is the only way status ever arrives. "Sync status" asks Vapi
 * directly instead, and any call still in flight is synced automatically on
 * load and every few seconds after, so this page never again just sits there
 * showing "queued" forever with no way to tell if anything is wrong.
 */
export function DiscountCallerConsole({
  cases,
  calls: initialCalls,
}: {
  cases: CallableCase[];
  calls: VoiceCallRow[];
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [calls, setCalls] = useState(initialCalls);
  const [syncing, setSyncing] = useState(false);
  const [webCall, setWebCall] = useState<{ caseId: string; state: WebCallState } | null>(null);
  const vapiRef = useRef<InstanceType<typeof Vapi> | null>(null);

  const hasPending = calls.some((c) => c.status === 'queued' || c.status === 'ringing' || c.status === 'in_progress');

  const refreshCalls = useCallback(async () => {
    const res = await fetch('/api/voice-agent/calls', { cache: 'no-store' });
    if (!res.ok) return;
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; calls?: VoiceCallRow[] };
    if (json.ok && json.calls) setCalls(json.calls);
  }, []);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      await fetch('/api/voice-agent/sync', { method: 'POST' });
      await refreshCalls();
    } catch {
      // A failed sync leaves the table showing whatever it last knew — not
      // worse than before, and the button is right there to try again.
    } finally {
      setSyncing(false);
    }
  }, [refreshCalls]);

  // Sync once on load, and keep polling every 8s for as long as anything is
  // still in flight — the moment nothing is pending, this stops on its own.
  useEffect(() => {
    if (!hasPending) return;
    void sync();
    const id = setInterval(() => void sync(), 8000);
    return () => clearInterval(id);
  }, [hasPending, sync]);

  /**
   * A call over the browser's own microphone — WebRTC to Vapi directly, no
   * telephony carrier involved at all. Same assistant, same tools, same
   * guardrail; the only thing that's different from a real phone call is the
   * transport, and the webhook doesn't know or care which one it was.
   */
  async function startWebCall(caseId: string) {
    const publicKey = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY;
    const assistantId = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;
    if (!publicKey || !assistantId) {
      setNotice('Web call is not configured — set NEXT_PUBLIC_VAPI_PUBLIC_KEY and NEXT_PUBLIC_VAPI_ASSISTANT_ID.');
      return;
    }

    setNotice(null);
    setWebCall({ caseId, state: 'connecting' });

    const vapi = new Vapi(publicKey);
    vapiRef.current = vapi;

    let registered = false;
    const registerOnce = async (vapiCallId: string | null) => {
      if (registered || !vapiCallId) return;
      registered = true;
      try {
        await fetch('/api/voice-agent/web-calls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ caseId, vapiCallId }),
        });
        await refreshCalls();
      } catch {
        // The webhook has its own fallback (resolveVoiceCall, keyed off the
        // call's metadata) — a failed registration here is not fatal.
      }
    };

    vapi.on('call-start', () => {
      setWebCall({ caseId, state: 'active' });
    });
    vapi.on('call-end', () => {
      setWebCall({ caseId, state: 'ended' });
      vapiRef.current = null;
      void refreshCalls();
    });
    vapi.on('error', (e: unknown) => {
      // Tear the session down for real, not just the UI's idea of it — an
      // error event on an already-active call must never leave audio running
      // with no control left on screen to stop it. That's the exact bug this
      // replaced: the banner (and its Hang Up button) vanished on error while
      // the underlying WebRTC session kept running.
      vapi.stop();
      vapiRef.current = null;
      setNotice(`Web call error: ${e instanceof Error ? e.message : String(e)}`);
      setWebCall({ caseId, state: 'ended' });
    });

    try {
      // `metadata` is attempted here as a first path to the case id; the
      // webhook's `resolveVoiceCall` fallback reads it if this lands, and
      // `registerOnce` below is the second, independent path — whichever one
      // succeeds is enough.
      const started = await vapi.start(assistantId, { metadata: { caseId } } as never);
      await registerOnce(extractCallId(started));
    } catch (e) {
      vapi.stop();
      vapiRef.current = null;
      setNotice(e instanceof Error ? e.message : 'Could not start the web call');
      setWebCall({ caseId, state: 'ended' });
    }
  }

  /** Always reachable, whatever state the UI thinks the call is in — belt and braces against exactly the "nothing on screen can stop it" failure above. */
  function stopWebCall() {
    vapiRef.current?.stop();
    vapiRef.current = null;
    setWebCall((w) => (w ? { ...w, state: 'ended' } : w));
  }

  return (
    <>
      {webCall && (
        <div
          className="notice"
          style={{
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            border: webCall.state !== 'ended' ? '1px solid var(--data)' : undefined,
          }}
        >
          <span>
            {webCall.state === 'connecting' && 'Connecting the web call — allow microphone access if prompted…'}
            {webCall.state === 'active' && 'Web call is live — talk into your microphone.'}
            {webCall.state === 'ended' && 'Web call ended.'}
          </span>
          {webCall.state !== 'ended' ? (
            <button
              type="button"
              className="btn-primary btn-sm"
              style={{ background: 'var(--critical)', flexShrink: 0 }}
              onClick={stopWebCall}
            >
              Hang up
            </button>
          ) : (
            <button type="button" className="btn-ghost" onClick={() => setWebCall(null)}>
              Dismiss
            </button>
          )}
        </div>
      )}

      <section className="card">
        {notice && (
          <div className="notice" style={{ margin: '12px 20px 0' }}>
            <span>{notice}</span>
          </div>
        )}

        {cases.length === 0 ? (
          <p className="subtle" style={{ padding: '16px 20px' }}>
            No open cases with a phone number on file yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="num">Amount</th>
                  <th>Cause</th>
                  <th>Customer</th>
                  <th>Opened</th>
                  <th aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td className="num">{inr(c.amountPaise)}</td>
                    <td>
                      <div className="cell-main">{causeLabel(c.causeClass)}</div>
                      <div className="cell-sub mono">{c.errorReason}</div>
                    </td>
                    <td>
                      <div className="cell-main">{c.customerName ?? '—'}</div>
                      <div className="cell-sub mono">{c.customerPhone}</div>
                    </td>
                    <td className="muted nowrap">{relativeTime(new Date(c.createdAt))}</td>
                    <td className="row-action">
                      <button
                        type="button"
                        className="btn-primary btn-sm"
                        disabled={webCall !== null}
                        onClick={() => void startWebCall(c.id)}
                        title="Talk to the agent through your browser's microphone — no phone, no carrier involved."
                      >
                        Web call
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Call history</span>
          <button type="button" className="btn-ghost" disabled={syncing} onClick={() => void sync()}>
            {syncing ? 'Syncing…' : 'Sync status'}
          </button>
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
                    <td>
                      <StatusCell status={c.status} endedReason={c.endedReason} />
                    </td>
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
    </>
  );
}

function StatusCell({ status, endedReason }: { status: string; endedReason: string | null }) {
  const isFailure = status === 'failed' || (status === 'ended' && Boolean(endedReason));
  return (
    <span className="pill" title={endedReason ?? undefined}>
      <span
        className="dot"
        style={{
          background: isFailure
            ? 'var(--critical)'
            : status === 'ended'
              ? 'var(--good)'
              : status === 'queued'
                ? 'var(--ink-muted)'
                : 'var(--data)',
        }}
      />
      {status.replace(/_/g, ' ')}
      {isFailure && endedReason ? <span className="cell-sub"> · {endedReason}</span> : null}
    </span>
  );
}
