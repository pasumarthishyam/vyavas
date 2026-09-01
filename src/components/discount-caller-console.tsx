'use client';

import { useState } from 'react';

import { causeLabel, inr, relativeTime } from './ui';
import type { CallableCase, VoiceCallRow } from '../db/queries/voice-agent';

/**
 * The "place a call" surface.
 *
 * Deliberately manual, one case at a time — this is the trial phase, and a
 * button a person clicks is the right amount of ceremony for an agent that
 * dials a phone and can offer money. Nothing here auto-fires.
 */
export function DiscountCallerConsole({
  cases,
  calls,
}: {
  cases: CallableCase[];
  calls: VoiceCallRow[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const calledCaseIds = new Set(calls.map((c) => c.caseId));

  async function call(caseId: string) {
    setBusy(caseId);
    setNotice(null);
    try {
      const res = await fetch('/api/voice-agent/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
      setNotice(json.ok ? 'Call placed.' : (json.reason ?? `Could not place the call (HTTP ${res.status})`));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  }

  return (
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
                      disabled={busy === c.id}
                      onClick={() => void call(c.id)}
                      title={calledCaseIds.has(c.id) ? 'A call has already been placed for this case' : undefined}
                    >
                      {busy === c.id ? 'Calling…' : calledCaseIds.has(c.id) ? 'Call again' : 'Call now'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
