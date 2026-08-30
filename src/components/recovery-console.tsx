'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
 * One job: see every case that needs acting on, and act on it.
 *
 * ── why this is a table and not a stack of cards ──
 *
 * It was cards: one large panel per case, amount set in display type, every
 * attribute on its own line. That reads beautifully with three cases and falls
 * apart at thirty. A merchant doing fifty failures a day — an ordinary Tuesday
 * for a mid-size store — got a page metres long, no way to find the ₹40,000 one
 * among the ₹300 ones, and no way to see at a glance how much was at stake.
 *
 * Density is not a cosmetic choice here, it is the feature. A row per case, the
 * amount right-aligned so magnitudes line up and compare down the column, and
 * everything that is not needed for a decision moved to the case page. Fifty
 * rows fit in two screens and sort in one click.
 *
 * What is deliberately NOT here: charts, date ranges, revenue trends. Those are
 * the Overview page's job. A console that also tries to be a dashboard buries
 * the one control that matters.
 */

interface Routing {
  whatsappRedirectTo: string | null;
  emailRedirectTo: string | null;
  emailFrom: string | null;
}

interface Payload {
  merchant: ConsoleMerchant | null;
  routing?: Routing;
  cases: RecoverableCase[];
  activity: ActivityRow[];
  summary: RecoverySummary;
  now: string;
  /** True when the server render could not reach the database. */
  degraded?: boolean;
}

const POLL_MS = 4000;
const NOTICE_TTL_MS = 90_000;
const STALE_AFTER_POLLS = 3;
/** Rows drawn before "show more". Enough for a normal day, not enough to hang. */
const PAGE_SIZE = 25;

type Filter = 'all' | 'ready' | 'touched' | 'blocked';
type Sort = 'amount' | 'newest' | 'deadline';

interface Notice {
  message: string;
  at: number;
  tone: 'error' | 'ok';
}

/** A case whose send was refused only because it already went out once. */
interface Confirm {
  caseId: string;
  amountPaise: number;
  detail: string;
}

export function RecoveryConsole({ initial }: { initial: Payload }) {
  const [data, setData] = useState<Payload>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [stalled, setStalled] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('amount');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [refreshing, setRefreshing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number>(() => Date.now());

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const misses = useRef(0);

  const say = useCallback((message: string, tone: Notice['tone'] = 'error') => {
    setNotice({ message, at: Date.now(), tone });
  }, []);

  const poll = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/recovery/status', { cache: 'no-store' });

      if (res.ok) {
        misses.current = 0;
        setStalled(null);
        const next = (await res.json()) as Payload;
        setData(next);
        setSyncedAt(Date.now());
        // A case stays "pending" from the moment its follow-up is scheduled
        // until its email actually appears in the log — otherwise it reads
        // "email sending…" forever, because nothing ever told it the email left.
        setPending((p) => {
          const still = Object.fromEntries(
            Object.entries(p).filter(
              ([caseId]) =>
                !next.activity.some(
                  (a) => a.caseId === caseId && a.kind === 'message' && a.channel === 'email',
                ),
            ),
          );
          return Object.keys(still).length === Object.keys(p).length ? p : still;
        });
      } else {
        misses.current += 1;
        const body = (await res.json().catch(() => ({}))) as { reason?: string };
        if (misses.current >= STALE_AFTER_POLLS) {
          setStalled(body.reason ?? `The server answered ${res.status}.`);
        }
      }
    } catch {
      // One dropped poll is not worth surfacing. Several in a row is: silence
      // is exactly how a page that has stopped updating passes for one with
      // nothing to report.
      misses.current += 1;
      if (misses.current >= STALE_AFTER_POLLS) {
        setStalled('Not reaching the server. This page has stopped updating.');
      }
    }
  }, []);

  /** Schedule the next poll after the current one settles, never on a fixed drum. */
  const loop = useCallback(async (): Promise<void> => {
    await poll();
    timer.current = setTimeout(() => void loop(), POLL_MS);
  }, [poll]);

  useEffect(() => {
    timer.current = setTimeout(() => void loop(), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [loop]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), NOTICE_TTL_MS);
    return () => clearTimeout(id);
  }, [notice]);

  /**
   * Manual refresh.
   *
   * The page already polls, so this is not strictly load-bearing — but a poll
   * you cannot see and cannot trigger is indistinguishable from a page that has
   * frozen, and the honest answer to "is this current?" was previously to
   * reload the whole document. The button restarts the timer as well as
   * fetching, so an impatient click does not leave two loops running.
   */
  const refresh = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    setRefreshing(true);
    try {
      await poll();
    } finally {
      setRefreshing(false);
      timer.current = setTimeout(() => void loop(), POLL_MS);
    }
  }, [poll, loop]);

  async function start(caseId: string, force = false) {
    setBusy(caseId);
    setNotice(null);

    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 45_000);

    try {
      const res = await fetch('/api/recovery/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId, force }),
        signal: controller.signal,
      });

      // A 500 from a crashed route returns HTML, and `.json()` on HTML throws a
      // parse error that reads like a bug in this component. Report the status.
      const text = await res.text();
      let json: {
        ok?: boolean;
        reason?: string;
        followUpAt?: string | null;
        alreadySent?: boolean;
      };
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        say(`Server returned ${res.status} — ${text.slice(0, 120) || 'no body'}`);
        return;
      }

      if (json.ok) {
        say(force ? 'Sent again.' : 'Recovery started.', 'ok');
        if (json.followUpAt) setPending((p) => ({ ...p, [caseId]: json.followUpAt! }));
      } else if (json.alreadySent && !force) {
        // Not a dead end — an override a person is allowed to make, with the
        // consequence stated before they make it.
        const c = data.cases.find((x) => x.id === caseId);
        setConfirm({
          caseId,
          amountPaise: c?.amountPaise ?? 0,
          detail: json.reason ?? 'This case has already been sent.',
        });
      } else {
        say(json.reason ?? `Could not start (HTTP ${res.status})`);
      }

      await poll();
    } catch (e) {
      say(
        e instanceof DOMException && e.name === 'AbortError'
          ? 'No response in 45s. The server holds its own 38s budget, so it never reached the route.'
          : e instanceof Error
            ? e.message
            : 'Request failed',
      );
    } finally {
      clearTimeout(abort);
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
    await refresh();
  }

  const merchant = data.merchant;
  const mode: SendMode = !merchant?.executionEnabled
    ? 'off'
    : merchant.dryRun
      ? 'dry_run'
      : 'live';
  const live = mode === 'live';
  const canStart = mode !== 'off';

  // ── the visible set ──
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();

    const matches = data.cases.filter((c) => {
      const blocked = c.optedOut || (!c.hasPhone && !c.hasEmail);
      if (filter === 'ready' && (blocked || c.messagesSent > 0)) return false;
      if (filter === 'touched' && c.messagesSent === 0) return false;
      if (filter === 'blocked' && !blocked) return false;

      if (!q) return true;
      // Amount is searched as digits so "9588" finds ₹9,588 without the user
      // having to guess the formatting.
      return [
        String(Math.round(c.amountPaise / 100)),
        causeLabel(c.causeClass),
        c.errorReason ?? '',
        c.method,
        c.bank ?? '',
        c.customerName ?? '',
        c.emailMasked ?? '',
        c.phoneMasked ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });

    const sorted = [...matches].sort((a, b) => {
      if (sort === 'amount') return b.amountPaise - a.amountPaise;
      if (sort === 'newest') return +new Date(b.createdAt) - +new Date(a.createdAt);
      const ad = a.deadlineAt ? +new Date(a.deadlineAt) : Infinity;
      const bd = b.deadlineAt ? +new Date(b.deadlineAt) : Infinity;
      return ad - bd;
    });

    return sorted;
  }, [data.cases, query, filter, sort]);

  const atRisk = data.cases.reduce((s, c) => s + c.amountPaise, 0);
  const shownRisk = shown.reduce((s, c) => s + c.amountPaise, 0);
  const readyCount = data.cases.filter(
    (c) => !(c.optedOut || (!c.hasPhone && !c.hasEmail)) && c.messagesSent === 0,
  ).length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{merchant?.name ?? 'Recovery'}</div>
          <h1>Recovery</h1>
        </div>
        <ModeSwitch mode={mode} onChange={setMode} disabled={!merchant} />
      </div>

      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <Stat
          label="At risk"
          value={inr(atRisk)}
          foot={`${data.cases.length} open case${data.cases.length === 1 ? '' : 's'}`}
        />
        <Stat
          label="Needs a first touch"
          value={String(readyCount)}
          foot={readyCount === 0 ? 'all contacted' : 'not yet messaged'}
        />
        <Stat
          label="Recovered"
          value={inr(data.summary.recoveredPaise)}
          foot={`${data.summary.recoveredCases} case${data.summary.recoveredCases === 1 ? '' : 's'}`}
        />
      </div>

      {notice && (
        <div className={`notice${notice.tone === 'error' ? ' notice-critical' : ' notice-ok'}`}>
          {notice.tone === 'error' ? <WarnIcon /> : <CheckIcon />}
          <span>
            {notice.message} <span className="subtle">· {relativeTime(new Date(notice.at))}</span>
          </span>
        </div>
      )}

      {stalled && (
        <div className="notice notice-critical">
          <WarnIcon />
          <span>
            {stalled} Showing the last data received — it may be stale.{' '}
            <button type="button" className="link-btn" onClick={() => void refresh()}>
              Retry now
            </button>
          </span>
        </div>
      )}

      {data.degraded && !stalled && (
        <div className="notice">
          <InfoIcon />
          <span>
            This page loaded before the database answered. It is refreshing itself — nothing is
            wrong with your data.
          </span>
        </div>
      )}

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

      <section className="panel" style={{ marginTop: 20 }}>
        <Toolbar
          query={query}
          onQuery={(v) => {
            setQuery(v);
            setLimit(PAGE_SIZE);
          }}
          filter={filter}
          onFilter={(f) => {
            setFilter(f);
            setLimit(PAGE_SIZE);
          }}
          sort={sort}
          onSort={setSort}
          shown={shown.length}
          total={data.cases.length}
          shownRisk={shownRisk}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          syncedAt={syncedAt}
        />

        <CaseTable
          rows={shown.slice(0, limit)}
          live={live}
          canStart={canStart}
          busy={busy}
          pending={pending}
          now={data.now}
          onStart={(id) => void start(id)}
          emptyReason={
            data.cases.length === 0
              ? 'no-cases'
              : shown.length === 0
                ? 'no-matches'
                : null
          }
        />

        {shown.length > limit && (
          <button
            type="button"
            className="show-more"
            onClick={() => setLimit((n) => n + PAGE_SIZE)}
          >
            Show {Math.min(PAGE_SIZE, shown.length - limit)} more · {shown.length - limit} remaining
          </button>
        )}
      </section>

      <Activity rows={data.activity} />

      {confirm && (
        <ConfirmResend
          confirm={confirm}
          live={live}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const id = confirm.caseId;
            setConfirm(null);
            void start(id, true);
          }}
        />
      )}
    </>
  );
}

/* ── toolbar ─────────────────────────────────────────────────────────────── */

function Toolbar({
  query,
  onQuery,
  filter,
  onFilter,
  sort,
  onSort,
  shown,
  total,
  shownRisk,
  refreshing,
  onRefresh,
  syncedAt,
}: {
  query: string;
  onQuery: (v: string) => void;
  filter: Filter;
  onFilter: (f: Filter) => void;
  sort: Sort;
  onSort: (s: Sort) => void;
  shown: number;
  total: number;
  shownRisk: number;
  refreshing: boolean;
  onRefresh: () => void;
  syncedAt: number;
}) {
  const FILTERS: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'ready', label: 'Needs a touch' },
    { value: 'touched', label: 'Contacted' },
    { value: 'blocked', label: 'Unreachable' },
  ];

  return (
    <div className="toolbar">
      <div className="toolbar-search">
        <SearchIcon />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search amount, cause, customer…"
          aria-label="Search cases"
        />
      </div>

      <div className="segmented segmented-sm" role="group" aria-label="Filter cases">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            className={`segment${filter === f.value ? ' segment-on' : ''}`}
            onClick={() => onFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <label className="toolbar-sort">
        <span className="visually-hidden">Sort by</span>
        <select value={sort} onChange={(e) => onSort(e.target.value as Sort)}>
          <option value="amount">Largest first</option>
          <option value="newest">Newest first</option>
          <option value="deadline">Closing soonest</option>
        </select>
      </label>

      <div className="toolbar-meta">
        <span className="toolbar-count">
          {shown === total ? `${total}` : `${shown} of ${total}`}
          {shown > 0 && <span className="subtle"> · {inr(shownRisk)}</span>}
        </span>
        <RefreshButton refreshing={refreshing} onRefresh={onRefresh} syncedAt={syncedAt} />
      </div>
    </div>
  );
}

/**
 * Refresh, with the freshness stated next to it.
 *
 * The label is the point. "Refresh" alone invites a click every few seconds
 * because nothing on screen says whether the data is already current; naming
 * the age answers that question without a click, and most of the time stops the
 * click happening at all.
 */
function RefreshButton({
  refreshing,
  onRefresh,
  syncedAt,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  syncedAt: number;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const age = Math.round((Date.now() - syncedAt) / 1000);
  const label = refreshing ? 'Refreshing…' : age < 8 ? 'Up to date' : `${age}s ago`;

  return (
    <button
      type="button"
      className={`refresh${refreshing ? ' refresh-busy' : ''}`}
      onClick={onRefresh}
      disabled={refreshing}
      title="Fetch the latest cases now"
    >
      <RefreshIcon />
      <span>{label}</span>
    </button>
  );
}

/* ── the table ───────────────────────────────────────────────────────────── */

function CaseTable({
  rows,
  live,
  canStart,
  busy,
  pending,
  now,
  onStart,
  emptyReason,
}: {
  rows: RecoverableCase[];
  live: boolean;
  canStart: boolean;
  busy: string | null;
  pending: Record<string, string>;
  now: string;
  onStart: (id: string) => void;
  emptyReason: 'no-cases' | 'no-matches' | null;
}) {
  if (emptyReason === 'no-cases') {
    return (
      <div className="empty">
        <div className="empty-title">No open cases</div>
        <div className="empty-body">
          Run <span className="mono">npm run backfill</span> to pull failures from a connected
          Razorpay account, or wait for a live webhook.
        </div>
      </div>
    );
  }

  if (emptyReason === 'no-matches') {
    return (
      <div className="empty">
        <div className="empty-title">Nothing matches</div>
        <div className="empty-body">No open case matches that search or filter.</div>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="data data-cases">
        <thead>
          <tr>
            <th className="num">Amount</th>
            <th>Cause</th>
            <th>Customer</th>
            <th>Opened</th>
            <th>Deadline</th>
            <th>Status</th>
            <th aria-label="Action" />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <CaseRow
              key={c.id}
              c={c}
              live={live}
              canStart={canStart}
              busy={busy === c.id}
              followUpAt={pending[c.id] ?? null}
              now={now}
              onStart={() => onStart(c.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CaseRow({
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
  const urgent = hoursLeft != null && hoursLeft < 6;

  return (
    <tr className={urgent ? 'row-urgent' : undefined}>
      <td className="num amount-cell">
        <a href={`/cases/${c.id}`}>{inr(c.amountPaise)}</a>
      </td>

      <td>
        <div className="cell-main">{causeLabel(c.causeClass)}</div>
        <div className="cell-sub mono">{c.errorReason}</div>
      </td>

      <td>
        <div className="reach-pair">
          <span className={`reach${c.hasPhone ? '' : ' reach-off'}`} title={c.phoneMasked ?? 'no phone'}>
            <ChatIcon />
          </span>
          <span className={`reach${c.hasEmail ? '' : ' reach-off'}`} title={c.emailMasked ?? 'no email'}>
            <MailIcon />
          </span>
          <span className="cell-sub">{c.emailMasked ?? c.phoneMasked ?? '—'}</span>
        </div>
      </td>

      <td className="muted nowrap">{relativeTime(new Date(c.createdAt))}</td>

      <td className={`nowrap${urgent ? ' urgent' : ' muted'}`}>
        {hoursLeft == null
          ? '—'
          : hoursLeft > 0
            ? `${Math.round(hoursLeft)}h left`
            : 'past deadline'}
      </td>

      <td>
        {followUpAt ? (
          <FollowUp at={followUpAt} />
        ) : c.messagesSent > 0 ? (
          <span className="pill">
            <span className="dot" style={{ background: 'var(--good)' }} />
            {c.messagesSent} sent
          </span>
        ) : blocked ? (
          <span className="pill">
            <span className="dot" style={{ background: 'var(--critical)' }} />
            {c.optedOut ? 'opted out' : 'unreachable'}
          </span>
        ) : (
          <span className="pill">
            <span className="dot" style={{ background: 'var(--ink-muted)' }} />
            waiting
          </span>
        )}
      </td>

      <td className="row-action">
        <button
          type="button"
          className="btn-primary btn-sm"
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
          {busy ? 'Starting…' : blocked ? 'Unreachable' : !canStart ? 'Off' : live ? 'Start' : 'Dry run'}
        </button>
      </td>
    </tr>
  );
}

/** Counts down to the scheduled email so the wait is visible, not mysterious. */
function FollowUp({ at }: { at: string }) {
  const [left, setLeft] = useState(() => Math.max(0, new Date(at).getTime() - Date.now()));

  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, new Date(at).getTime() - Date.now())), 1000);
    return () => clearInterval(id);
  }, [at]);

  if (left <= 0) return <span className="pill followup done">email sending…</span>;
  return <span className="pill followup">email in {Math.ceil(left / 1000)}s</span>;
}

/* ── confirm a resend ────────────────────────────────────────────────────── */

/**
 * The override, with its consequence stated first.
 *
 * A plain refusal was correct and useless: the operator often knows something
 * the ledger does not, and telling them "no" just moves the send off-system.
 * A confirm keeps the decision, the person and the record in one place.
 */
function ConfirmResend({
  confirm,
  live,
  onCancel,
  onConfirm,
}: {
  confirm: Confirm;
  live: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Escape closes. A modal that can only be dismissed by hitting the right
  // button is a modal people click through without reading.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="resend-title">
      <div className="overlay-backdrop" onClick={onCancel} />
      <div className="overlay-card">
        <h2 id="resend-title">Send this again?</h2>
        <p>{confirm.detail}.</p>
        <p>
          {live ? (
            <>
              This will send a <strong>second real message</strong> for{' '}
              <strong>{inr(confirm.amountPaise)}</strong> to the same person. It is recorded as its
              own attempt, not a correction of the first.
            </>
          ) : (
            <>
              Dry run — nothing will actually be delivered. The attempt is still written to the
              ledger so you can see exactly what would have gone out.
            </>
          )}
        </p>

        <div className="overlay-actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm}>
            {live ? 'Send again' : 'Run again'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── routing banner ──────────────────────────────────────────────────────── */

function maskPhone(phone: string): string {
  if (phone.length <= 7) return phone;
  return `${phone.slice(0, 3)}•••••${phone.slice(-4)}`;
}

function Routing({ routing, live }: { routing?: Routing; live: boolean }) {
  if (!routing) return null;

  const waDiverted = Boolean(routing.whatsappRedirectTo);
  const mailDiverted = Boolean(routing.emailRedirectTo);
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

/* ── the switch ──────────────────────────────────────────────────────────── */

const MODES: { value: SendMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Nothing runs' },
  { value: 'dry_run', label: 'Dry run', hint: 'Runs everything, sends nothing' },
  { value: 'live', label: 'Live', hint: 'Messages reach real recipients' },
];

function ModeSwitch({
  mode,
  onChange,
  disabled,
}: {
  mode: SendMode;
  onChange: (m: SendMode) => void;
  disabled?: boolean;
}) {
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
            disabled={disabled}
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

/* ── activity ────────────────────────────────────────────────────────────── */

const STATUS_TONE: Record<string, string> = {
  sent: 'var(--data)',
  delivered: 'var(--good)',
  read: 'var(--good)',
  queued: 'var(--ink-muted)',
  suppressed: 'var(--ink-muted)',
  failed: 'var(--critical)',
};

/**
 * What happened, and why.
 *
 * Collapsed by default now that it carries decisions as well as sends — it is
 * the thing you open when something looks wrong, not something you watch. It
 * reads `case_events` alongside `message_log`, which is what makes "nothing was
 * sent, and here is the reason" expressible at all.
 */
function Activity({ rows }: { rows: ActivityRow[] }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <button
        type="button"
        className="panel-head panel-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="panel-title">
          <ChevronIcon open={open} />
          Activity
        </span>
        <span className="card-sub">
          {rows.length === 0
            ? 'nothing yet'
            : `${rows.length} recent event${rows.length === 1 ? '' : 's'}`}
        </span>
      </button>

      {open &&
        (rows.length === 0 ? (
          <p className="subtle" style={{ fontSize: 13, padding: '0 16px 16px' }}>
            Nothing yet. Start a recovery above and every step appears here.
          </p>
        ) : (
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
                      <td className="muted nowrap">{relativeTime(new Date(r.at))}</td>
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
                          ? r.error.slice(0, 40)
                          : r.providerMessageId
                            ? `${r.providerMessageId.slice(0, 18)}…`
                            : '—'}
                      </td>
                    </tr>
                  ) : (
                    <tr key={r.id}>
                      <td className="muted nowrap">{relativeTime(new Date(r.at))}</td>
                      <td>
                        <span className="pill">
                          <GearIcon />
                          {r.event.replace(/_/g, ' ')}
                        </span>
                      </td>
                      {/*
                        The gate's own sentence, unedited. "already 2 message(s)
                        in 24h (cap 2)" is the whole answer to "why did nothing
                        send"; paraphrasing it into a status word throws away
                        the part that tells you what to do.
                      */}
                      <td>{r.reason ?? r.detail ?? '—'}</td>
                      <td className="muted">{r.actor}</td>
                      <td className="mono muted nowrap">
                        {r.retryAt ? `retry ${whenLabel(new Date(r.retryAt))}` : '—'}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

/* ── icons ───────────────────────────────────────────────────────────────── */

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

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7.2" cy="7.2" r="4.3" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.6 10.6 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M13.7 2v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s var(--ease)' }}
    >
      <path d="m6 3.5 5 4.5-5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
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

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="m5.4 8.2 1.9 1.9 3.4-3.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
