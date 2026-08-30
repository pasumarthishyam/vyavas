'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { inr, causeLabel, relativeTime, whenLabel, Stat } from './ui';
import type {
  ActivityRow,
  ConsoleMerchant,
  RecoverableCase,
  RecoverySummary,
} from '../db/queries/recovery';
import type { SendMode } from '../app/api/recovery/execution/route';

/*
 * The recovery console.
 *
 * One job: start a recovery on one case and watch what happens. Everything on
 * screen is either a case you can act on, the switch that decides whether
 * anything sends, or the record of what did.
 *
 * Three all-time numbers set the scene — open cases, failure classes, recovered
 * — but deliberately no charts, filters or date ranges. Those live on the
 * Overview page. A console that also tries to be a dashboard makes the button
 * harder to find, and the button is the whole point.
 */

/**
 * Where messages land, read from the merchant's own routing columns — the same
 * values the senders read.
 *
 * It used to be read from environment variables, which meant the banner could
 * report "diverted" while the sender was doing the opposite: the diversion was
 * disabled under NODE_ENV=production, but the banner did not know that, so the
 * one surface whose job is to tell you where messages go was confidently wrong
 * in exactly the situation that mattered.
 */
interface Routing {
  whatsappRedirectTo: string | null;
  emailRedirectTo: string | null;
  emailFrom: string | null;
}

interface Payload {
  merchant: ConsoleMerchant;
  routing?: Routing;
  cases: RecoverableCase[];
  activity: ActivityRow[];
  summary: RecoverySummary;
  now: string;
}

const POLL_MS = 2500;

/**
 * How long a failure notice stays up.
 *
 * It used to stay up forever — `setError` was only ever cleared by starting
 * another recovery — so a 45s timeout from four hours ago sat above a page that
 * had been polling happily ever since, describing a request nobody could still
 * remember making. A banner that outlives its fact is worse than no banner: it
 * sends you to look for a problem that is no longer there.
 */
const NOTICE_TTL_MS = 90_000;

/** Consecutive failed polls before the page admits it has stopped updating. */
const STALE_AFTER_POLLS = 3;

interface Notice {
  message: string;
  at: number;
}

export function RecoveryConsole({ initial }: { initial: Payload }) {
  const [data, setData] = useState<Payload>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [stalled, setStalled] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const misses = useRef(0);

  const fail = useCallback((message: string) => {
    setNotice({ message, at: Date.now() });
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/recovery/status', { cache: 'no-store' });

      if (res.ok) {
        misses.current = 0;
        setStalled(null);
        const next = (await res.json()) as Payload;
        setData(next);
        // A case stays "pending" from the moment its follow-up is scheduled
        // until the countdown hits zero — past that, without this, it shows
        // "email sending…" forever, because nothing ever told it the email
        // actually left. Clear it once that case's email appears in the
        // activity log, whatever the outcome.
        setPending((p) => {
          const stillPending = Object.fromEntries(
            Object.entries(p).filter(
              ([caseId]) =>
                !next.activity.some(
                  (a) => a.caseId === caseId && a.kind === 'message' && a.channel === 'email',
                ),
            ),
          );
          return Object.keys(stillPending).length === Object.keys(p).length ? p : stillPending;
        });
      } else {
        // A 503 here means the database stopped answering and the stale
        // connection has been dropped; the next poll reconnects. Say so only
        // once it has actually persisted — see below.
        misses.current += 1;
        const body = (await res.json().catch(() => ({}))) as { reason?: string };
        if (misses.current >= STALE_AFTER_POLLS) {
          setStalled(body.reason ?? `The server answered ${res.status}.`);
        }
      }
    } catch {
      // One dropped poll is not worth surfacing — the next is 2.5s away, and a
      // banner that flashes on every network blip trains people to ignore it.
      // Several in a row IS worth surfacing: silence is exactly how a page that
      // has stopped updating passes for one that has nothing to report.
      misses.current += 1;
      if (misses.current >= STALE_AFTER_POLLS) {
        setStalled('Not reaching the server. This page has stopped updating.');
      }
    }
    timer.current = setTimeout(() => void poll(), POLL_MS);
  }, []);

  // Expire the notice on a timer rather than at the next render, so it is
  // readable for a while and then gone for good.
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), NOTICE_TTL_MS);
    return () => clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    timer.current = setTimeout(() => void poll(), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

  async function start(caseId: string) {
    setBusy(caseId);
    setNotice(null);

    // A start can genuinely take a few seconds — it creates a payment link on
    // the merchant's Razorpay account before it can compose. But without a
    // deadline a request that never returns leaves the button reading
    // "Starting…" forever, which tells you nothing at all: no error, no state
    // change, nothing in the log to search for. A silent hang is the worst
    // failure this page can have, because it is the one you cannot report.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);

    try {
      const res = await fetch('/api/recovery/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId }),
        signal: controller.signal,
      });

      // A 500 from a crashed route returns HTML, and `.json()` on HTML throws a
      // parse error that reads like a bug in this component rather than what it
      // is. Report the status instead.
      const text = await res.text();
      let json: { ok?: boolean; reason?: string; followUpAt?: string | null };
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        fail(`Server returned ${res.status} — ${text.slice(0, 120) || 'no body'}`);
        return;
      }

      if (!json.ok) fail(json.reason ?? `Could not start (HTTP ${res.status})`);
      else if (json.followUpAt) setPending((p) => ({ ...p, [caseId]: json.followUpAt! }));
      await poll();
    } catch (e) {
      fail(
        e instanceof DOMException && e.name === 'AbortError'
          ? // The route now holds its own 38s budget and answers with a reason,
            // so reaching this at all means the request never got that far.
            'No response in 45s. The server should have answered by 38s, so it never ' +
            'reached the route — check the activity log below before retrying.'
          : e instanceof Error
            ? e.message
            : 'Request failed',
      );
    } finally {
      clearTimeout(timer);
      setBusy(null);
    }
  }

  async function setMode(mode: SendMode) {
    setNotice(null);
    await fetch('/api/recovery/execution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    await poll();
  }

  const mode: SendMode = !data.merchant.executionEnabled
    ? 'off'
    : data.merchant.dryRun
      ? 'dry_run'
      : 'live';
  const live = mode === 'live';
  const canStart = mode !== 'off';
  const total = data.cases.reduce((s, c) => s + c.amountPaise, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{data.merchant.name}</div>
          <h1>Recovery</h1>
        </div>

        <ModeSwitch mode={mode} onChange={setMode} />
      </div>

      <div className="grid grid-3" style={{ marginBottom: 24 }}>
        <Stat
          label="Open cases"
          value={String(data.cases.length)}
          foot={data.cases.length === 0 ? 'nothing open' : inr(total)}
        />
        <Stat
          label="Failure classes"
          value={String(data.summary.failureClasses)}
          foot={data.cases.length === 0 ? '—' : 'across open cases'}
        />
        <Stat
          label="Recovered"
          value={inr(data.summary.recoveredPaise)}
          foot={`${data.summary.recoveredCases} case${data.summary.recoveredCases === 1 ? '' : 's'}`}
        />
      </div>

      {/*
        Timestamped, so it cannot quietly become a description of something
        that stopped being true hours ago.
      */}
      {notice && (
        <div className="notice notice-critical">
          <WarnIcon />
          <span>
            {notice.message}{' '}
            <span className="subtle">· {relativeTime(new Date(notice.at))}</span>
          </span>
        </div>
      )}

      {/*
        Separate from the notice above, because it says something different: not
        "an action failed" but "everything you are looking at may be out of
        date". Without it a page whose polls are all failing looks identical to
        a page where nothing is happening.
      */}
      {stalled && (
        <div className="notice notice-critical">
          <WarnIcon />
          <span>
            {stalled} Showing the last data received — it may be stale. Retrying every{' '}
            {POLL_MS / 1000}s.
          </span>
        </div>
      )}

      {/*
        Where messages actually land, stated before the switch is thrown.
        "Sending is on" is not enough information: the same switch either
        diverts everything to one test phone or reaches a real customer, and
        which one it is cannot be inferred from the UI.
      */}
      <Routing routing={data.routing} live={live} />

      {mode === 'off' && data.cases.length > 0 && (
        <div className="notice">
          <InfoIcon />
          <span>
            Nothing runs while sending is off — the gate aborts before anything is composed. Switch
            to <strong style={{ fontWeight: 550 }}>Dry run</strong> to see exactly what would be
            sent, without sending it.
          </span>
        </div>
      )}

      <section className="stack" style={{ marginTop: 24 }}>
        {data.cases.length === 0 ? (
          <div className="empty">
            <div className="empty-title">No open cases</div>
            <div className="empty-body">
              Run <span className="mono">npm run backfill</span> to pull failures from a connected
              Razorpay account, or wait for a live webhook.
            </div>
          </div>
        ) : (
          data.cases.map((c) => (
            <CaseCard
              key={c.id}
              c={c}
              live={live}
              canStart={canStart}
              busy={busy === c.id}
              followUpAt={pending[c.id] ?? null}
              now={data.now}
              onStart={() => void start(c.id)}
            />
          ))
        )}
      </section>

      <section className="section">
        <div className="card">
          <div className="card-head">
            <h2>Activity</h2>
            <span className="card-sub">Live · updates every {POLL_MS / 1000}s</span>
          </div>
          <Activity rows={data.activity} />
        </div>
      </section>

      <p className="subtle" style={{ marginTop: 22, fontSize: 12.5, maxWidth: 620 }}>
        WhatsApp goes out immediately; the email follows 30 seconds later. In production those are 4
        minutes and 26 hours apart and run on a durable workflow — here the follow-up fires from
        this page, so it waits if you close the tab.
      </p>
    </>
  );
}

/** Same masking convention as everywhere else a phone number reaches a screen. */
function maskPhone(phone: string): string {
  if (phone.length <= 7) return phone;
  return `${phone.slice(0, 3)}•••••${phone.slice(-4)}`;
}

function Routing({ routing, live }: { routing?: Routing; live: boolean }) {
  if (!routing) return null;

  const waDiverted = Boolean(routing.whatsappRedirectTo);
  const mailDiverted = Boolean(routing.emailRedirectTo);
  // Critical only when something can actually reach a stranger right now.
  const reachesRealPeople = live && (!waDiverted || !mailDiverted);

  return (
    <div className={`notice${reachesRealPeople ? ' notice-critical' : ''}`}>
      {reachesRealPeople ? <WarnIcon /> : <InfoIcon />}
      <span>
        <strong style={{ fontWeight: 550 }}>WhatsApp</strong>{' '}
        {waDiverted ? (
          <>
            → <span className="mono">+{maskPhone(routing.whatsappRedirectTo!)}</span>, never the
            customer.
          </>
        ) : (
          <>
            → the <strong style={{ fontWeight: 550 }}>real customer number</strong>.
          </>
        )}
        {' · '}
        <strong style={{ fontWeight: 550 }}>Email</strong>{' '}
        {mailDiverted ? (
          <>
            → <span className="mono">{routing.emailRedirectTo}</span>, never the customer.
          </>
        ) : (
          <>
            → the <strong style={{ fontWeight: 550 }}>real customer address</strong>
            {routing.emailFrom ? (
              <>
                {' '}from <span className="mono">{routing.emailFrom}</span>
              </>
            ) : null}
            .
          </>
        )}
        {reachesRealPeople && (
          <>
            {' '}
            <strong style={{ fontWeight: 550 }}>Sending is live — real people will receive this.</strong>
          </>
        )}
      </span>
    </div>
  );
}

/* ── the switch ─────────────────────────────────────────────────────────── */

/**
 * Three states, because the system has three.
 *
 * A two-way toggle forced "dry run" and "off" into one position, and they are
 * not the same thing at all: off aborts at the gate and produces no record,
 * dry run exercises everything and records exactly what would have been sent.
 * The middle option is the one you actually want most of the time.
 */
const MODES: { value: SendMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Nothing runs' },
  { value: 'dry_run', label: 'Dry run', hint: 'Runs everything, sends nothing' },
  { value: 'live', label: 'Live', hint: 'Messages reach real recipients' },
];

function ModeSwitch({ mode, onChange }: { mode: SendMode; onChange: (m: SendMode) => void }) {
  const active = MODES.find((m) => m.value === mode) ?? MODES[0]!;
  return (
    <div className="exec">
      <div className="exec-label">
        <span className="exec-title">{active.label}</span>
        <span className="exec-sub">{active.hint}</span>
      </div>
      <div className="segmented" role="radiogroup" aria-label="Send mode">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={mode === m.value}
            className={`segment${mode === m.value ? ' segment-on' : ''}${m.value === 'live' && mode === 'live' ? ' segment-live' : ''}`}
            onClick={() => onChange(m.value)}
            title={m.hint}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── one case ───────────────────────────────────────────────────────────── */

function CaseCard({
  c,
  live,
  canStart,
  busy,
  followUpAt,
  now,
  onStart,
}: {
  c: RecoverableCase;
  live: boolean;
  canStart: boolean;
  busy: boolean;
  followUpAt: string | null;
  now: string;
  onStart: () => void;
}) {
  const blocked = c.optedOut || (!c.hasPhone && !c.hasEmail);
  const deadline = c.deadlineAt ? new Date(c.deadlineAt) : null;
  const hoursLeft = deadline ? (deadline.getTime() - new Date(now).getTime()) / 3_600_000 : null;

  return (
    <article className="case-card">
      <div className="case-main">
        <div className="case-amount">{inr(c.amountPaise)}</div>
        <div className="case-cause">{causeLabel(c.causeClass)}</div>
        <div className="case-meta">
          <span className="mono">{c.errorReason}</span>
          <span>·</span>
          <span>
            {c.method}
            {c.bank ? ` · ${c.bank}` : ''}
          </span>
          <span>·</span>
          <span>opened {relativeTime(new Date(c.createdAt))}</span>
          {hoursLeft != null && (
            <>
              <span>·</span>
              <span className={hoursLeft < 6 ? 'urgent' : undefined}>
                {hoursLeft > 0 ? `${Math.round(hoursLeft)}h left` : 'past deadline'}
              </span>
            </>
          )}
        </div>

        <div className="case-reach">
          <Reach ok={c.hasPhone} label={c.phoneMasked ?? 'no phone'} icon={<ChatIcon />} />
          <Reach ok={c.hasEmail} label={c.emailMasked ?? 'no email'} icon={<MailIcon />} />
          {c.messagesSent > 0 && (
            <span className="pill">
              {c.messagesSent} sent
            </span>
          )}
        </div>
      </div>

      <div className="case-action">
        {followUpAt && <FollowUp at={followUpAt} />}
        <button
          type="button"
          className="btn-primary"
          disabled={busy || blocked || !canStart}
          onClick={onStart}
          title={
            c.optedOut
              ? 'This customer has opted out'
              : blocked
                ? 'No reachable channel'
                : undefined
          }
        >
          {busy
            ? 'Starting…'
            : blocked
              ? 'Unreachable'
              : !canStart
                ? 'Sending off'
                : live
                  ? 'Start recovery'
                  : 'Dry run'}
        </button>
      </div>
    </article>
  );
}

function Reach({ ok, label, icon }: { ok: boolean; label: string; icon: React.ReactNode }) {
  return (
    <span className={`reach${ok ? '' : ' reach-off'}`}>
      {icon}
      {label}
    </span>
  );
}

/** Counts down to the scheduled email so the wait is visible, not mysterious. */
function FollowUp({ at }: { at: string }) {
  const [left, setLeft] = useState(() => Math.max(0, new Date(at).getTime() - Date.now()));

  useEffect(() => {
    const id = setInterval(
      () => setLeft(Math.max(0, new Date(at).getTime() - Date.now())),
      1000,
    );
    return () => clearInterval(id);
  }, [at]);

  if (left <= 0) return <span className="followup done">email sending…</span>;
  return <span className="followup">email in {Math.ceil(left / 1000)}s</span>;
}

/* ── activity ───────────────────────────────────────────────────────────── */

const STATUS_TONE: Record<string, string> = {
  sent: 'var(--data)',
  delivered: 'var(--good)',
  read: 'var(--good)',
  queued: 'var(--ink-muted)',
  suppressed: 'var(--ink-muted)',
  failed: 'var(--critical)',
};

function Activity({ rows }: { rows: ActivityRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="subtle" style={{ fontSize: 13 }}>
        Nothing sent yet. Start a recovery above and it appears here.
      </p>
    );
  }

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>When</th>
            <th>What</th>
            <th>Detail</th>
            <th>Outcome</th>
            <th>Reference</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) =>
            r.kind === 'message' ? (
              <tr key={r.id}>
                <td className="muted">{relativeTime(new Date(r.at))}</td>
                <td>
                  <span className="pill">
                    {r.channel === 'email' ? <MailIcon /> : <ChatIcon />}
                    {r.channel}
                  </span>
                </td>
                <td>{r.intent.replace(/_/g, ' ')}</td>
                <td>
                  <span className="pill">
                    <span
                      className="dot"
                      style={{ background: STATUS_TONE[r.status] ?? 'var(--ink-muted)' }}
                    />
                    {r.suppressedReason ?? r.status}
                  </span>
                </td>
                <td className="mono muted">
                  {r.error
                    ? r.error.slice(0, 48)
                    : r.providerMessageId
                      ? `${r.providerMessageId.slice(0, 22)}…`
                      : '—'}
                </td>
              </tr>
            ) : (
              <tr key={r.id}>
                <td className="muted">{relativeTime(new Date(r.at))}</td>
                <td>
                  <span className="pill">
                    <GearIcon />
                    {r.event.replace(/_/g, ' ')}
                  </span>
                </td>
                {/*
                  The gate's own sentence, unedited. "already 2 message(s) in 24h
                  (cap 2)" is the whole answer to "why did nothing send", and
                  paraphrasing it into a status word would throw away the only
                  part that tells you what to do about it.
                */}
                <td>{r.reason ?? r.detail ?? '—'}</td>
                <td className="muted">{r.actor}</td>
                <td className="mono muted">
                  {r.retryAt ? `retry ${whenLabel(new Date(r.retryAt))}` : '—'}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ── icons ──────────────────────────────────────────────────────────────── */

function ChatIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M14 7.6c0 2.9-2.7 5.3-6 5.3-.9 0-1.7-.2-2.5-.5L2 13.5l1.2-2.8A5 5 0 0 1 2 7.6c0-2.9 2.7-5.3 6-5.3s6 2.4 6 5.3Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3.5" width="12" height="9" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="m2.6 4.6 5.4 3.9 5.4-3.9" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** Marks a decision row — something the system worked out, not something it sent. */
function GearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.9v1.5M8 12.6v1.5M14.1 8h-1.5M3.4 8H1.9M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1M12.3 12.3l-1.1-1.1M4.8 4.8 3.7 3.7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 5.2v3.4M8 11.2h.01" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path
        d="M6.8 2.4 1.6 11.6A1.4 1.4 0 0 0 2.8 13.7h10.4a1.4 1.4 0 0 0 1.2-2.1L9.2 2.4a1.4 1.4 0 0 0-2.4 0Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 7.2v4M8 4.9h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
