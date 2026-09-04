import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getDb } from '../../../../db/client';
import { getCaseDetail } from '../../../../db/queries/case-detail';
import { Ladder, Pill, StatePill, causeHint, causeLabel, inr, relativeTime } from '../../../../components/ui';

export const dynamic = 'force-dynamic';

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getCaseDetail(getDb(), id);
  if (!detail) notFound();

  const terminal = ['recovered', 'lost', 'aborted'].includes(detail.state);

  return (
    <>
      <Link href="/cases" className="back">
        ← Cases
      </Link>

      <div className="page-head">
        <div>
          <div className="eyebrow">{causeLabel(detail.causeClass)}</div>
          <h1>{inr(detail.amountPaise, false)}</h1>
          <p className="subtle" style={{ marginTop: 8, maxWidth: 460 }}>
            {causeHint(detail.causeClass)}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <StatePill state={detail.state} />
          <Pill>{detail.attended ? 'Attended' : 'Unattended'}</Pill>
          <Pill>{detail.cohort === 'holdout' ? 'Holdout' : 'Treatment'}</Pill>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h2>What Razorpay told us</h2>
            <span className="card-sub">The routing key</span>
          </div>
          <dl className="kv">
            <dt>Reason</dt>
            <dd className="mono">{detail.errorReason ?? '—'}</dd>
            <dt>Source</dt>
            <dd className="mono">{detail.errorSource ?? '—'}</dd>
            <dt>Step</dt>
            <dd className="mono">{detail.errorStep ?? '—'}</dd>
            <dt>Code</dt>
            <dd className="mono">{detail.errorCode ?? '—'}</dd>
            <dt>Method</dt>
            <dd>
              {detail.method}
              {detail.bank ? ` · ${detail.bank}` : ''}
              {detail.network ? ` · ${detail.network}` : ''}
            </dd>
            {detail.rawErrorReason && detail.rawErrorReason !== detail.errorReason ? (
              <>
                <dt>Raw reason</dt>
                <dd className="mono" style={{ color: 'var(--warning)' }}>
                  {detail.rawErrorReason}
                </dd>
              </>
            ) : null}
            <dt>Order</dt>
            <dd className="mono muted">{detail.rzpOrderId ?? '—'}</dd>
            <dt>Payment</dt>
            <dd className="mono muted">{detail.rzpPaymentId ?? '—'}</dd>
          </dl>

          <div className="divider" />

          <p className="subtle" style={{ fontSize: 12.5 }}>
            These five fields are stored separately and never collapsed. The same reason means
            different things depending on where it surfaced — <span className="mono">authentication_failed</span>{' '}
            from the customer is a mistyped OTP; from the gateway it is infrastructure.
          </p>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Case</h2>
            <span className="card-sub">Confidence: {detail.confidence ?? 'unknown'}</span>
          </div>
          <dl className="kv">
            <dt>Type</dt>
            <dd>{detail.type.replace(/_/g, ' ')}</dd>
            <dt>Customer</dt>
            <dd className="mono">
              {detail.customerContact ?? '—'}
              {detail.customerOptedOut ? (
                <span style={{ color: 'var(--critical)' }}> · opted out</span>
              ) : null}
            </dd>
            <dt>Opened</dt>
            <dd>{relativeTime(detail.createdAt)}</dd>
            <dt>Deadline</dt>
            <dd>
              {detail.deadlineAt
                ? detail.deadlineAt.toLocaleString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    hour: 'numeric',
                    minute: '2-digit',
                  })
                : '—'}
            </dd>
            {terminal ? (
              <>
                <dt>Resolved</dt>
                <dd>{detail.resolvedAt ? relativeTime(detail.resolvedAt) : '—'}</dd>
              </>
            ) : null}
            {detail.recoveredAmountPaise != null ? (
              <>
                <dt>Recovered</dt>
                <dd style={{ color: 'var(--good-text)', fontWeight: 500 }}>
                  {inr(detail.recoveredAmountPaise, false)}
                </dd>
              </>
            ) : null}
            <dt>Policy</dt>
            <dd className="mono">
              {detail.policyId ?? '—'}
              {detail.policyVersion ? (
                <span className="muted"> v{detail.policyVersion}</span>
              ) : null}
            </dd>
          </dl>

          <div className="divider" />

          <p className="subtle" style={{ fontSize: 12.5 }}>
            {detail.attended ? (
              <>
                <strong style={{ fontWeight: 550 }}>Attended.</strong> No mandate exists, so under
                RBI rules there is no lawful way to re-present this debit. Recovery means bringing
                the customer back to a payment surface.
              </>
            ) : (
              <>
                <strong style={{ fontWeight: 550 }}>Unattended.</strong> An active mandate covers
                this debit, so it may be re-presented — subject to the pre-debit notification
                requirement.
              </>
            )}
          </p>
        </div>
      </div>

      {detail.rationale.length > 0 && (
        <section className="section">
          <div className="card">
            <div className="card-head">
              <h2>Why we classified it this way</h2>
              <span className="card-sub">Written at diagnosis, never regenerated</span>
            </div>
            <ul className="rationale">
              {detail.rationale.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="section">
        <div className="card">
          <div className="card-head">
            <h2>What would happen</h2>
            <span className="card-sub">
              {detail.policy
                ? `${detail.policy.ladder.length} step${detail.policy.ladder.length === 1 ? '' : 's'} · max ${detail.policy.maxMessages} message${detail.policy.maxMessages === 1 ? '' : 's'}`
                : 'No policy stamped'}
            </span>
          </div>

          {detail.policy ? (
            <>
              <p className="subtle" style={{ marginBottom: 24, maxWidth: 620 }}>
                {detail.policy.description}
              </p>
              <Ladder rungs={detail.policy.ladder as never} />

              <div className="divider" />

              <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', fontSize: 12.5 }}>
                <div>
                  <div className="muted" style={{ marginBottom: 6 }}>
                    Checked before every step
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {detail.policy.preconditions.map((p) => (
                      <Pill key={p}>{p.replace(/_/g, ' ')}</Pill>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="muted" style={{ marginBottom: 6 }}>
                    Stops immediately on
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {detail.policy.abortOn.map((p) => (
                      <Pill key={p}>{p.replace(/_/g, ' ')}</Pill>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <p className="subtle">This case has no policy stamped on it.</p>
          )}

          <p className="subtle" style={{ marginTop: 26, fontSize: 12.5 }}>
            <strong style={{ fontWeight: 550 }}>Nothing here has run.</strong> Execution arrives in
            a later stage, behind a per-merchant switch that starts off. This is what the agent
            would do, shown before you are asked to trust it with anything.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="card">
          <div className="card-head">
            <h2>History</h2>
            <span className="card-sub">Append-only · {detail.events.length} entries</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Transition</th>
                  <th>Actor</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {detail.events.map((e) => (
                  <tr key={e.id}>
                    <td style={{ fontWeight: 500 }}>{e.kind.replace(/_/g, ' ')}</td>
                    <td className="muted">
                      {e.fromState && e.toState ? (
                        <>
                          {e.fromState} → {e.toState}
                        </>
                      ) : (
                        (e.toState ?? '—')
                      )}
                      {e.reason ? <span className="muted"> · {e.reason}</span> : null}
                    </td>
                    <td className="muted">{e.actor}</td>
                    <td className="muted">{relativeTime(e.occurredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
