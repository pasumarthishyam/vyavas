import { formatINR, type Paise } from '../core/money';

/*
 * The non-chart pieces.
 *
 * Status colour appears only in `Alert` and `StatePill`, and never alone: each
 * pairs the colour with an icon or a word. Two of the four status steps sit
 * below 3:1 on the light surface by design, so the pairing is the mitigation,
 * not a nicety.
 */

export const inr = (p: number, compact = true) => formatINR(p as Paise, { compact });

// ─── stat tile ───────────────────────────────────────────────────────────────

export function Stat({
  label,
  value,
  foot,
}: {
  label: string;
  value: string;
  foot?: React.ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {foot ? <div className="stat-foot">{foot}</div> : null}
    </div>
  );
}

// ─── cause class ─────────────────────────────────────────────────────────────

const CAUSE_LABELS: Record<string, string> = {
  transient_infra: 'Bank or gateway down',
  instrument_dead: 'Card or account unusable',
  customer_input: 'Customer typo',
  auth_friction: 'OTP or 3DS incomplete',
  funds_limits: 'Funds or limits',
  risk: 'Risk decline',
  merchant_config: 'Your configuration',
  terminal_noop: 'Already paid',
  intent_exit: 'Customer left',
};

export const causeLabel = (c: string | null) =>
  c ? (CAUSE_LABELS[c] ?? c.replace(/_/g, ' ')) : 'Unclassified';

/** One-line explanation of what has to change for the money to arrive. */
const CAUSE_HINTS: Record<string, string> = {
  transient_infra: 'The instrument is fine — only the timing was bad.',
  instrument_dead: 'This card or handle will never work. The customer must switch.',
  customer_input: 'A typo. The highest-recovery class there is.',
  auth_friction: 'The authentication step did not complete.',
  funds_limits: 'The money or the headroom was not there. Timing is the lever.',
  risk: 'The issuer refused. Trying harder makes it worse.',
  merchant_config: 'Something on your side is broken. Every customer hitting this is lost.',
  terminal_noop: 'No revenue at risk.',
  intent_exit: 'A choice, not a malfunction.',
};

export const causeHint = (c: string | null) => (c ? (CAUSE_HINTS[c] ?? '') : '');

// ─── pills ───────────────────────────────────────────────────────────────────

const STATE_COLOR: Record<string, string> = {
  detected: 'var(--ink-muted)',
  diagnosed: 'var(--data)',
  executing: 'var(--data)',
  paused: 'var(--warning)',
  recovered: 'var(--good)',
  lost: 'var(--critical)',
  aborted: 'var(--ink-muted)',
};

export function StatePill({ state }: { state: string }) {
  return (
    <span className="pill">
      <span className="dot" style={{ background: STATE_COLOR[state] ?? 'var(--ink-muted)' }} />
      {state}
    </span>
  );
}

export function Pill({ children }: { children: React.ReactNode }) {
  return <span className="pill">{children}</span>;
}

// ─── alerts ──────────────────────────────────────────────────────────────────

const SEVERITY: Record<string, { color: string; bg: string; label: string }> = {
  critical: { color: 'var(--critical)', bg: 'rgba(208,59,59,0.12)', label: 'Critical' },
  warning: { color: 'var(--warning)', bg: 'rgba(250,178,25,0.16)', label: 'Warning' },
  info: { color: 'var(--data)', bg: 'var(--data-soft)', label: 'Info' },
};

export function Alert({
  severity,
  title,
  body,
  meta,
}: {
  severity: string;
  title: string;
  body?: string | null;
  meta?: React.ReactNode;
}) {
  const s = SEVERITY[severity] ?? SEVERITY.info!;
  return (
    <div className="alert">
      <div className="alert-icon" style={{ background: s.bg, color: s.color }}>
        <WarnIcon />
      </div>
      <div style={{ minWidth: 0 }}>
        {/* The severity word carries the meaning; the colour only reinforces it. */}
        <div className="alert-title">
          <span style={{ color: s.color }}>{s.label}</span>
          <span style={{ color: 'var(--ink-muted)', margin: '0 6px' }}>·</span>
          {title}
        </div>
        {body ? <div className="alert-body">{body}</div> : null}
        {meta ? <div className="alert-meta">{meta}</div> : null}
      </div>
    </div>
  );
}

function WarnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 5.2v3.4M8 11.2h.01"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M6.8 2.4 1.6 11.6A1.4 1.4 0 0 0 2.8 13.7h10.4a1.4 1.4 0 0 0 1.2-2.1L9.2 2.4a1.4 1.4 0 0 0-2.4 0Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ─── ladder ──────────────────────────────────────────────────────────────────

const INTENT_COPY: Record<string, string> = {
  switch_method: 'Ask them to pay a different way',
  retry_now_service_restored: 'Tell them the bank is back and the payment is ready',
  reminder: 'A neutral reminder with a working link',
  final_reminder: 'Last touch, still calm',
  cart_saved: 'Let them know the order is saved',
  pre_debit_notice: 'Notice ahead of the mandate debit (RBI)',
  subscription_at_risk: 'Warn that the subscription is about to lapse',
  invoice_due: 'The invoice is due',
  bank_action_required: 'Explain the setting they need to change at their bank',
};

const ACTION_COPY: Record<string, string> = {
  nudge: 'Message the customer',
  retry_debit: 'Re-present the mandated debit',
  send_pre_debit_notice: 'Send the pre-debit notice',
  await_downtime_resolution: 'Wait for the bank to recover',
  merchant_alert: 'Alert you',
  escalate_to_human: 'Put it in front of a person',
};

export interface LadderRung {
  at: string;
  action: string;
  channels?: readonly string[];
  intent?: string;
  suggest?: readonly string[];
  note?: string;
  timeout?: string;
  severity?: string;
  queue?: string;
}

export function Ladder({ rungs }: { rungs: readonly LadderRung[] }) {
  if (rungs.length === 0) {
    return (
      <div className="subtle">
        No ladder. This case class does nothing at all — there is no revenue at risk, so nothing
        is scheduled and nothing is sent.
      </div>
    );
  }

  return (
    <div className="ladder">
      {rungs.map((r, i) => (
        <div className="rung" key={`${r.at}-${i}`}>
          <div className="rung-at">{humanAt(r.at)}</div>
          <div className="rung-body">
            <div className="rung-title">{ACTION_COPY[r.action] ?? r.action}</div>
            {r.intent ? (
              <div className="rung-detail">{INTENT_COPY[r.intent] ?? r.intent}</div>
            ) : null}
            {r.note ? (
              <div className="rung-detail" style={{ color: 'var(--ink-muted)', marginTop: 4 }}>
                {r.note}
              </div>
            ) : null}
            <div className="rung-tags">
              {r.channels?.map((c) => <Pill key={c}>{c}</Pill>)}
              {r.suggest?.map((s) => <Pill key={s}>{s.replace(/_/g, ' ')}</Pill>)}
              {r.timeout ? <Pill>timeout {humanAt(r.timeout)}</Pill> : null}
              {r.queue ? <Pill>{r.queue.replace(/_/g, ' ')}</Pill> : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** `4m` → `4 min`, `26h` → `26 hr`, `3d` → `3 days`. */
function humanAt(at: string): string {
  const m = /^(\d+)([smhd])$/.exec(at);
  if (!m) return at;
  const n = Number(m[1]);
  const unit = m[2];
  if (n === 0) return 'Now';
  if (unit === 's') return `${n} sec`;
  if (unit === 'm') return `${n} min`;
  if (unit === 'h') return `${n} hr`;
  return `${n} day${n === 1 ? '' : 's'}`;
}

// ─── misc ────────────────────────────────────────────────────────────────────

export function relativeTime(d: Date, now = new Date()): string {
  const ms = now.getTime() - d.getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/**
 * The same idea as `relativeTime`, but honest about the future.
 *
 * `relativeTime` subtracts in one direction only, so anything still to come
 * lands in its `mins < 1` branch and renders as "just now". That is fine for a
 * log of things that have happened and actively wrong for a scheduled one: a
 * retry an hour out would read as though it had already gone.
 */
export function whenLabel(d: Date, now = new Date()): string {
  const ms = d.getTime() - now.getTime();
  if (ms <= 0) return relativeTime(d, now);

  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'in under a minute';
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs} hr`;
  const days = Math.round(hrs / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

export function Delta({ pct }: { pct: number | null }) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const up = pct > 0;
  const flat = Math.abs(pct) < 0.5;
  if (flat) {
    return <span className="delta muted">Flat vs previous period</span>;
  }
  return (
    // More money at risk is bad, so "up" wears the critical colour. The arrow
    // and the words carry it too — never the colour alone.
    <span className={`delta ${up ? 'delta-up' : 'delta-down'}`}>
      {up ? '↑' : '↓'} {Math.abs(pct).toFixed(0)}% vs previous period
    </span>
  );
}
