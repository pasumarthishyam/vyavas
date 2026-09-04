'use client';

import { useCallback, useEffect, useState } from 'react';

import { inr, relativeTime, whenLabel } from './ui';
import type { AbandonedCartRow } from '../db/queries/abandoned-cart-agent';

/**
 * The cart history table, its status sync, and one cart's full story.
 *
 * ── why the status column was rebuilt ──
 *
 * It printed `cart.status` raw, and `cart.status` is the CART's lifecycle, not
 * a delivery receipt. `emailed` there has only ever meant "a payment link was
 * issued and something has to watch it for payment" — it was stamped whether
 * the email was sent, suppressed by a dry run, refused by the frequency cap or
 * rejected outright by the provider. So a console that had delivered nothing at
 * all said "emailed", in a green-ish pill, next to a customer's address. The
 * failed-payment console never had this problem because it reads the message
 * ledger and says "Email skipped — dry run" in as many words.
 *
 * This one now reads the same ledger (`deliveryStatus`, joined from
 * `message_log`) plus the cart's own recorded verdict (`emailStatus`, for the
 * outcomes that never write a ledger row at all, like a capped customer), and
 * splits the two facts into two columns: what stage the cart is at, and what
 * actually reached the person. Neither can silently stand in for the other.
 */
export function AbandonedCartConsole({
  carts: initialCarts,
  paused,
  emailRedirectTo,
}: {
  carts: AbandonedCartRow[];
  /** The merchant's send mode, so a cart that was never processed can say why. */
  paused: boolean;
  /** Where email is diverted, if it is. Named on the row that "sent" applies to. */
  emailRedirectTo: string | null;
}) {
  const [carts, setCarts] = useState(initialCarts);
  const [syncing, setSyncing] = useState(false);
  const [open, setOpen] = useState<AbandonedCartRow | null>(null);

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
    <section className="panel">
      <div className="panel-head panel-head-ruled">
        <span className="panel-title">
          Cart activity
          {carts.length > 0 && <span className="count-badge">{carts.length}</span>}
        </span>
        <button
          type="button"
          className="refresh"
          disabled={syncing}
          onClick={() => void sync()}
          title="Ask the payment provider for the current status of every open link"
        >
          {syncing ? 'Syncing…' : 'Sync status'}
        </button>
      </div>
      {carts.length === 0 ? (
        <p className="panel-empty">
          No abandoned carts reported yet — once your application calls the webhook, they&apos;ll
          show up here.
        </p>
      ) : (
        <div className="table-wrap panel-scroll">
          <table className="data data-cases">
            <thead>
              <tr>
                <th className="num">Amount</th>
                <th>Stage</th>
                <th>Email</th>
                <th>Customer</th>
                <th>Link</th>
                <th>Reported</th>
              </tr>
            </thead>
            <tbody>
              {carts.map((c) => {
                const stage = stageOf(c);
                const email = emailOutcome(c, paused);
                return (
                  <tr
                    key={c.id}
                    className="row-clickable"
                    onClick={() => setOpen(c)}
                    title="Open this cart"
                  >
                    <td className="num amount-cell">{inr(c.amountPaise)}</td>
                    <td>
                      <div className="cell-main step-line">
                        <span className="dot" style={{ background: TONE_COLOR[stage.tone] }} />
                        {stage.label}
                      </div>
                      {stage.detail && <div className="cell-sub">{stage.detail}</div>}
                    </td>
                    <td>
                      <div className="cell-main step-line">
                        <span
                          className={`dot${email.tone === 'progress' ? ' dot-pulse' : ''}`}
                          style={{ background: TONE_COLOR[email.tone] }}
                        />
                        {email.label}
                      </div>
                      {email.detail && <div className="cell-sub">{email.detail}</div>}
                    </td>
                    <td>
                      <div className="cell-main">{c.customerName ?? '—'}</div>
                      <div className="cell-sub mono">{c.customerEmail}</div>
                    </td>
                    <td>
                      {c.paymentLinkUrl ? (
                        <>
                          <a
                            href={c.paymentLinkUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mono"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {inr(c.paymentLinkAmountPaise ?? 0)}
                          </a>
                          {c.discountAmountPaise ? (
                            <div className="cell-sub">{inr(c.discountAmountPaise)} off</div>
                          ) : null}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="muted nowrap">{relativeTime(toDate(c.createdAt))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <CartDrawer
          cart={carts.find((c) => c.id === open.id) ?? open}
          paused={paused}
          emailRedirectTo={emailRedirectTo}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

/* ── the two readings of a cart ──────────────────────────────────────────── */

type Tone = 'progress' | 'done' | 'failed' | 'muted' | 'warning';

const TONE_COLOR: Record<Tone, string> = {
  progress: 'var(--data)',
  done: 'var(--good)',
  failed: 'var(--critical)',
  warning: 'var(--warning)',
  muted: 'var(--ink-muted)',
};

interface Line {
  label: string;
  detail: string | null;
  tone: Tone;
}

/** JSON from the poll gives strings where the server render gave Dates. */
function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

function maybeDate(v: Date | string | null): Date | null {
  return v == null ? null : toDate(v);
}

/** Where the CART is: reported, link live, paid, expired, never got a link. */
function stageOf(c: AbandonedCartRow): Line {
  if (c.status === 'recovered') {
    const at = maybeDate(c.paymentConfirmedAt);
    return { label: 'Paid', detail: at ? relativeTime(at) : null, tone: 'done' };
  }
  if (c.status === 'expired') {
    return { label: 'Expired unpaid', detail: 'the 24h link has closed', tone: 'muted' };
  }
  if (c.status === 'failed') {
    return { label: 'Could not process', detail: c.failureReason, tone: 'failed' };
  }
  /*
   * Not a failure. A correct decision.
   *
   * The same person already had a payment failure being recovered, so the
   * failed-payment agent owns them and this cart was declined rather than
   * emailed. Toned muted, never red — a merchant reading red here would go
   * looking for a bug in an integration that is working exactly as intended.
   */
  if (c.status === 'suppressed') {
    return {
      label: 'Left to the recovery agent',
      detail: c.emailDetail ?? 'this customer had a payment failure in flight',
      tone: 'muted',
    };
  }
  if (c.status === 'emailed') {
    const expires = maybeDate(c.paymentLinkExpiresAt);
    const past = expires != null && expires.getTime() <= Date.now();
    return {
      label: 'Link live',
      detail: expires ? (past ? 'past its 24h window' : `expires ${whenLabel(expires)}`) : null,
      tone: past ? 'muted' : 'progress',
    };
  }
  // `detected`: the row exists because the merchant's app reported it, and
  // nothing has been created for it. The one common cause is worth naming.
  return {
    label: 'Reported',
    detail: 'no link created yet',
    tone: 'muted',
  };
}

/** Why a send never happened, in the send path's own vocabulary. */
const REFUSAL_COPY: Record<string, string> = {
  frequency_cap: 'this customer had already had their messages for today',
  opted_out: 'this customer has opted out',
  duplicate: 'an email for this cart had already been recorded',
  dry_run: 'the account was in a dry run',
  holdout: 'this customer is in the holdout group',
};

const refusalCopy = (reason: string | null) =>
  reason ? (REFUSAL_COPY[reason] ?? reason.replace(/_/g, ' ')) : null;

/**
 * What actually reached the customer.
 *
 * Reads the live ledger row first — it keeps moving after the send, so a bounce
 * reported by the provider an hour later shows up here — and falls back to the
 * verdict the cart recorded for the outcomes that never write a ledger row.
 */
function emailOutcome(c: AbandonedCartRow, paused: boolean): Line {
  const d = c.deliveryStatus;

  if (d === 'suppressed' || c.deliverySuppressedReason) {
    return {
      label: 'Skipped',
      detail: refusalCopy(c.deliverySuppressedReason ?? c.emailDetail),
      tone: 'muted',
    };
  }
  if (d === 'read') return { label: 'Read', detail: null, tone: 'done' };
  if (d === 'delivered') {
    const at = maybeDate(c.deliveredAt);
    return { label: 'Delivered', detail: at ? relativeTime(at) : null, tone: 'done' };
  }
  if (d === 'sent') {
    const at = maybeDate(c.emailSentAt);
    return { label: 'Sent', detail: at ? relativeTime(at) : null, tone: 'done' };
  }
  if (d === 'queued') return { label: 'Sending…', detail: null, tone: 'progress' };
  if (d === 'failed') {
    return { label: 'Failed', detail: c.deliveryError ?? c.emailDetail, tone: 'failed' };
  }

  switch (c.emailStatus) {
    case 'sent':
      return { label: 'Sent', detail: null, tone: 'done' };
    case 'refused':
      return { label: 'Not sent', detail: refusalCopy(c.emailDetail), tone: 'warning' };
    case 'suppressed':
      return { label: 'Skipped', detail: refusalCopy(c.emailDetail), tone: 'muted' };
    case 'failed':
      return { label: 'Failed', detail: c.emailDetail, tone: 'failed' };
    case 'no_channel':
      return { label: 'Not sent', detail: c.emailDetail ?? 'no email channel', tone: 'warning' };
    case 'not_composed':
      return { label: 'Not sent', detail: c.emailDetail, tone: 'warning' };
  }

  // No ledger row and no recorded verdict. Either nothing was attempted, or the
  // row predates delivery tracking — say which, rather than guessing.
  if (c.status === 'detected') {
    return {
      label: 'Nothing sent',
      detail: paused ? 'the agent is paused' : 'not processed yet',
      tone: 'muted',
    };
  }
  if (c.status === 'failed') return { label: 'Nothing sent', detail: null, tone: 'muted' };
  return {
    label: c.emailSentAt ? 'Recorded as sent' : 'Unknown',
    detail: 'before this agent tracked delivery',
    tone: 'muted',
  };
}

/* ── one cart, in full ───────────────────────────────────────────────────── */

interface Rung {
  at: Date | null;
  title: string;
  detail: string | null;
  tone: Tone;
}

/**
 * The whole story of one cart, in the order it happened.
 *
 * The same shape as the recovery console's case drawer, and for the same
 * reason: every claim on the row above is a prefix of this list, so the two can
 * never disagree about what happened.
 */
function CartDrawer({
  cart: c,
  paused,
  emailRedirectTo,
  onClose,
}: {
  cart: AbandonedCartRow;
  paused: boolean;
  emailRedirectTo: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const stage = stageOf(c);
  const email = emailOutcome(c, paused);
  const expires = maybeDate(c.paymentLinkExpiresAt);
  const rungs: Rung[] = [];

  rungs.push({
    at: toDate(c.createdAt),
    title: 'Cart reported',
    detail: `Your application posted cart ${c.externalCartId} — ${inr(c.amountPaise, false)}`,
    tone: 'muted',
  });

  if (c.status === 'failed') {
    rungs.push({
      at: null,
      title: 'Could not process',
      detail: c.failureReason ?? 'no reason recorded',
      tone: 'failed',
    });
  }

  if (c.paymentLinkUrl) {
    rungs.push({
      at: null,
      title: `Payment link created — ${inr(c.paymentLinkAmountPaise ?? 0, false)}`,
      detail: [
        c.discountAmountPaise ? `${inr(c.discountAmountPaise, false)} off the cart` : null,
        expires
          ? expires.getTime() > Date.now()
            ? `valid ${whenLabel(expires)}`
            : `expired ${relativeTime(expires)}`
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
      tone: 'progress',
    });
  }

  if (c.paymentLinkUrl || c.emailStatus || c.deliveryStatus) {
    rungs.push({
      at: maybeDate(c.emailSentAt),
      title: `Email — ${email.label.toLowerCase()}`,
      detail:
        [email.detail, email.label === 'Sent' || email.label === 'Delivered' ? `to ${emailRedirectTo ?? c.customerEmail}` : null]
          .filter(Boolean)
          .join(' · ') || null,
      tone: email.tone,
    });
  }

  if (c.deliveredAt) {
    rungs.push({
      at: maybeDate(c.deliveredAt),
      title: 'Delivered',
      detail: 'the provider confirmed it reached the inbox',
      tone: 'done',
    });
  }

  if (c.status === 'recovered') {
    rungs.push({
      at: maybeDate(c.paymentConfirmedAt),
      title: 'Paid',
      detail: `${inr(c.paymentLinkAmountPaise ?? c.amountPaise, false)} recovered`,
      tone: 'done',
    });
  } else if (c.status === 'expired') {
    rungs.push({
      at: expires,
      title: 'Link expired unpaid',
      detail: 'the 24h window closed with no payment',
      tone: 'muted',
    });
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Abandoned cart, ${inr(c.amountPaise)}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>

        <div className="drawer-head">
          <div className="eyebrow">Abandoned cart</div>
          <div className="drawer-amount">{inr(c.amountPaise, false)}</div>
          <p className="subtle" style={{ marginTop: 4, fontSize: 12.5 }}>
            <span className="mono">{c.externalCartId}</span> · reported{' '}
            {relativeTime(toDate(c.createdAt))}
          </p>

          <div className="drawer-tags">
            <span className="pill">
              <span className="dot" style={{ background: TONE_COLOR[stage.tone] }} />
              {stage.label}
            </span>
            <span className="pill">
              <span className="dot" style={{ background: TONE_COLOR[email.tone] }} />
              email {email.label.toLowerCase()}
            </span>
            <span className="cell-sub">{c.customerEmail}</span>
          </div>
        </div>

        <div className="drawer-body">
          <h2 className="drawer-heading">What&rsquo;s happened</h2>

          <div className="ladder">
            {rungs.map((r, i) => (
              <div className="rung" key={i}>
                <div className="rung-at">{r.at ? relativeTime(r.at) : '—'}</div>
                <div className={`rung-body tone-${r.tone === 'warning' ? 'muted' : r.tone}`}>
                  <div className="rung-title">{r.title}</div>
                  {r.detail && <div className="rung-detail">{r.detail}</div>}
                </div>
              </div>
            ))}
          </div>

          {emailRedirectTo && (email.label === 'Sent' || email.label === 'Delivered') && (
            <p className="subtle" style={{ fontSize: 12.5, marginTop: 12 }}>
              Email on this account is diverted to <span className="mono">{emailRedirectTo}</span>,
              so the customer did not receive it.
            </p>
          )}

          {c.emailBody && (
            <>
              <h2 className="drawer-heading" style={{ marginTop: 22 }}>
                {email.label === 'Sent' || email.label === 'Delivered' || email.label === 'Read'
                  ? 'What was sent'
                  : 'What would have been sent'}
              </h2>
              <pre className="mono message-preview">{c.emailBody}</pre>
            </>
          )}
        </div>

        {c.paymentLinkUrl && (
          <div className="drawer-foot">
            <a href={c.paymentLinkUrl} target="_blank" rel="noreferrer" className="link-btn">
              Open the payment link →
            </a>
          </div>
        )}
      </aside>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
