'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Vapi from '@vapi-ai/web';

import { causeLabel, inr, relativeTime } from './ui';
import type { CallableCase, VoiceCallRow } from '../db/queries/voice-agent';

type WebCallState = 'connecting' | 'active' | 'ended';

/** A call the server refused on the per-case ceiling, offered to a person. */
interface CallOverride {
  caseId: string;
  reason: string;
  callsPlaced: number;
}

type AuthorizeVerdict =
  | { ok: true; requiresOverride: false }
  | { ok: true; requiresOverride: true; reason: string; callsPlaced: number }
  | { ok: false; reason: string };

/**
 * The server's answer to "may this case be called right now".
 *
 * A network failure answers **no**. The alternative — assuming yes when the
 * check itself could not run — makes the ceiling disappear exactly when the
 * system is least healthy, which is the worst moment to start dialling.
 */
async function authorizeCall(caseId: string, override: boolean): Promise<AuthorizeVerdict> {
  try {
    const res = await fetch('/api/voice-agent/authorize-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseId, override }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      allowed?: boolean;
      requiresOverride?: boolean;
      reason?: string | null;
      callsPlaced?: number;
    };

    if (!res.ok || !json.ok) {
      return { ok: false, reason: json.reason ?? `Could not check the call limit (HTTP ${res.status})` };
    }
    if (json.requiresOverride) {
      return {
        ok: true,
        requiresOverride: true,
        reason: json.reason ?? 'This case has reached its call limit.',
        callsPlaced: json.callsPlaced ?? 0,
      };
    }
    return { ok: true, requiresOverride: false };
  } catch {
    return { ok: false, reason: 'Could not reach the server to check the call limit. Nothing was dialled.' };
  }
}

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
  /** Set when the server refused on the call limit and a person may override. */
  const [confirmCall, setConfirmCall] = useState<CallOverride | null>(null);
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
  async function startWebCall(caseId: string, override = false) {
    const publicKey = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY;
    const assistantId = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;
    if (!publicKey || !assistantId) {
      setNotice('Web call is not configured — set NEXT_PUBLIC_VAPI_PUBLIC_KEY and NEXT_PUBLIC_VAPI_ASSISTANT_ID.');
      return;
    }

    /*
     * Ask the server first, every time.
     *
     * A web call starts in the browser, so the only moment a limit can be
     * enforced is before `vapi.start()` — afterwards the phone has already
     * rung. And the answer has to come from the server rather than from the
     * `callCount` on this page: that number is from whenever the list last
     * rendered, and two people on two screens would each see "1 call" and each
     * place a second one.
     */
    const verdict = await authorizeCall(caseId, override);
    if (!verdict.ok) {
      setNotice(verdict.reason);
      return;
    }
    if (verdict.requiresOverride) {
      // Not an error and not a refusal — a decision that belongs to a person.
      setConfirmCall({ caseId, reason: verdict.reason, callsPlaced: verdict.callsPlaced });
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
          // Carried through so the case timeline records this call as a human
          // decision rather than as one the agent made on its own.
          body: JSON.stringify({ caseId, vapiCallId, override }),
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
      {confirmCall && (
        <ConfirmOverCallLimit
          confirm={confirmCall}
          onCancel={() => setConfirmCall(null)}
          onConfirm={() => {
            const { caseId } = confirmCall;
            setConfirmCall(null);
            // Second pass, this time carrying the override the person just gave.
            void startWebCall(caseId, true);
          }}
        />
      )}

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

      <section className="panel">
        <div className="panel-head panel-head-ruled">
          <span className="panel-title">
            Cases you can call
            {cases.length > 0 && <span className="count-badge">{cases.length}</span>}
          </span>
          <span className="card-sub">Open, with a phone number on file</span>
        </div>

        {notice && (
          <div className="notice" style={{ margin: '12px 16px 0' }}>
            <span>{notice}</span>
          </div>
        )}

        {cases.length === 0 ? (
          <p className="panel-empty">No open cases with a phone number on file yet.</p>
        ) : (
          /* Scrolls inside itself. A merchant with a hundred callable cases was
             getting a page several screens long before the call history — which
             is the half of this page you actually come back to check. */
          <div className="table-wrap panel-scroll">
            <table className="data data-cases">
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
                    <td className="num amount-cell">{inr(c.amountPaise)}</td>
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
                      {/*
                        A blocked case is SHOWN with its reason rather than hidden.
                        An operator looking for a case they know exists should find
                        it and be told why it is unavailable, not conclude the list
                        is broken. The route enforces the same two rules server-side,
                        because a disabled button is a courtesy and not a control.
                      */}
                      {c.blockedReason ? (
                        <span className="muted nowrap" title={c.blockedReason}>
                          {c.state === 'paused' ? 'Paused' : `${c.ageDays}d old`}
                        </span>
                      ) : (
                        <button
                          type="button"
                          /* At the ceiling the button stays live but stops
                             looking like the default action — it opens a
                             confirmation rather than dialling. Hiding it would
                             just move the call to someone's own phone, where
                             nothing records it. */
                          className={c.needsCallOverride ? 'btn-ghost btn-sm' : 'btn-primary btn-sm'}
                          disabled={webCall !== null}
                          onClick={() => void startWebCall(c.id)}
                          title={
                            c.needsCallOverride
                              ? `Called ${c.callCount} time${c.callCount === 1 ? '' : 's'} already — this asks you to confirm first.`
                              : "Talk to the agent through your browser's microphone — no phone, no carrier involved."
                          }
                        >
                          {c.needsCallOverride ? `Call again · ${c.callCount}` : 'Web call'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head panel-head-ruled">
          <span className="panel-title">
            Call history
            {calls.length > 0 && <span className="count-badge">{calls.length}</span>}
          </span>
          <button
            type="button"
            className="refresh"
            disabled={syncing}
            onClick={() => void sync()}
            title="Ask the provider for the current status of every call"
          >
            {syncing ? 'Syncing…' : 'Sync status'}
          </button>
        </div>
        {calls.length === 0 ? (
          <p className="panel-empty">No calls placed yet.</p>
        ) : (
          <div className="table-wrap panel-scroll">
            <table className="data data-cases">
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

/**
 * The third call, with what it is stated before it happens.
 *
 * Same shape as the recovery console's resend confirmation, and for the same
 * reason: a refusal a person cannot pass is a refusal they route around — they
 * will pick up their own phone, and nothing will record that they did. This
 * keeps the decision, the person and the record in one place.
 */
function ConfirmOverCallLimit({
  confirm,
  onCancel,
  onConfirm,
}: {
  confirm: CallOverride;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="call-limit-title">
      <div className="overlay-backdrop" onClick={onCancel} />
      <div className="overlay-card">
        <h2 id="call-limit-title">Call this customer again?</h2>
        <p>{confirm.reason}</p>
        <p>
          Placing this call is <strong>your decision</strong>, not the agent&rsquo;s. It is written
          to the case timeline as a manual override, with the count it passed.
        </p>

        <div className="overlay-actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm}>
            Call anyway
          </button>
        </div>
      </div>
    </div>
  );
}
