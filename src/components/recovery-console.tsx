'use client';

import Link from 'next/link';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { inr, causeLabel, maskPhone, relativeTime, whenLabel, Stat, INTENT_COPY } from './ui';
import type {
  ActivityCategory,
  ActivityRow,
  AiHealth,
  CaseStep,
  ConsoleAlert,
  ConsoleEscalation,
  ConsoleMerchant,
  PlannedStep,
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
  activityHasMore?: boolean | null;
  summary: RecoverySummary;
  /** Cases the ladder handed to a person. Not gated on a panel being open. */
  escalations?: ConsoleEscalation[];
  /** Merchant breakage alerts still unresolved. */
  alerts?: ConsoleAlert[];
  /** Whether Claude is actually writing the briefs, or the fallback is. */
  ai?: AiHealth;
  /** Case ids with an open escalation, for the "Needs a person" filter. */
  escalatedCaseIds?: string[];
  now: string;
  /** True when the server render could not reach the database. */
  degraded?: boolean;
}

const POLL_MS = 4000;
const NOTICE_TTL_MS = 90_000;
const STALE_AFTER_POLLS = 3;
/** Rows drawn before "show more". Enough for a normal day, not enough to hang. */
const PAGE_SIZE = 25;

type Filter = 'all' | 'ready' | 'touched' | 'blocked' | 'escalated';
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
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  /**
   * The going-live preview, held open while a person decides.
   *
   * Null means no decision is pending. It is fetched fresh every time the
   * switch is pressed rather than polled with the rest of the console: a stale
   * count of who is about to be messaged is worse than no count.
   */
  /** The case whose drawer is open, captured at click time so the drawer keeps
   *  working even if the case later drops out of the open-cases list (e.g. it
   *  resolves while someone is reading its trace). */
  const [openCase, setOpenCase] = useState<RecoverableCase | null>(null);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  /*
   * Newest first.
   *
   * It defaulted to largest-amount, on the reasoning that the biggest number is
   * the most valuable thing to act on. True in aggregate, wrong while you are
   * working: the case you care about is almost always the one that just came
   * in, and having it appear somewhere in the middle of the list by size made
   * the page feel like it had not updated at all. Sorting by money is still one
   * click away for the times you are triaging a backlog rather than watching.
   */
  const [sort, setSort] = useState<Sort>('newest');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [refreshing, setRefreshing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number>(() => Date.now());

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const misses = useRef(0);
  /** Set by the Activity panel while it is open. A ref, so opening it does not
   *  restart the poll loop the way a state dependency would. */
  const wantActivity = useRef(false);

  const say = useCallback((message: string, tone: Notice['tone'] = 'error') => {
    setNotice({ message, at: Date.now(), tone });
  }, []);

  const poll = useCallback(async (): Promise<void> => {
    try {
      // Only ask for the activity feed when the panel showing it is open. It is
      // the most expensive read on the route and the panel is collapsed by
      // default, so polling it every few seconds was paying for a table nobody
      // was looking at.
      const url = wantActivity.current
        ? '/api/recovery/status?activity=1'
        : '/api/recovery/status';
      const res = await fetch(url, { cache: 'no-store' });

      if (res.ok) {
        misses.current = 0;
        setStalled(null);
        const next = (await res.json()) as Payload;
        // A poll that did not ask for activity returns null for it; keep
        // whatever was last loaded rather than blanking the panel.
        setData((prev) => ({ ...next, activity: next.activity ?? prev.activity }));
        setSyncedAt(Date.now());
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

  /**
   * Act on an escalation.
   *
   * The console is otherwise read-only, and this is the deliberate exception:
   * a queue nobody can clear is the same failure as the `case_actions` row
   * nobody read, one layer up.
   */
  async function actOnEscalation(
    id: string,
    action: 'acknowledge' | 'resolve' | 'dismiss',
    note?: string,
  ) {
    setBusy(id);
    try {
      const res = await fetch('/api/recovery/escalation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, note }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };

      if (json.ok) {
        say(
          action === 'acknowledge'
            ? 'Picked up.'
            : action === 'resolve'
              ? 'Marked resolved.'
              : 'Dismissed.',
          'ok',
        );
      } else {
        say(json.reason ?? `Could not ${action} (HTTP ${res.status})`);
      }
      await poll();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

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
        alreadySent?: boolean;
      };
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        say(`Server returned ${res.status} — ${text.slice(0, 120) || 'no body'}`);
        return;
      }

      if (json.ok) {
        // The follow-up this scheduled shows up as `nextAction` on the next
        // poll below — no client state to set here for it to appear.
        say(force ? 'Sent again.' : 'Recovery started.', 'ok');
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

  const merchant = data.merchant;
  const mode: SendMode = merchant?.executionEnabled ? 'live' : 'paused';
  const live = mode === 'live';
  // Nothing can be started by hand while the agent is paused either. The gate
  // would park the case again on its first rung, which reads as a broken button.
  const canStart = live;

  // ── the visible set ──
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();

    const escalated = new Set(data.escalatedCaseIds ?? []);

    const matches = data.cases.filter((c) => {
      const blocked = c.optedOut || (!c.hasPhone && !c.hasEmail);
      if (filter === 'ready' && (blocked || c.messagesSent > 0)) return false;
      if (filter === 'touched' && c.messagesSent === 0) return false;
      if (filter === 'blocked' && !blocked) return false;
      if (filter === 'escalated' && !escalated.has(c.id)) return false;

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
  }, [data.cases, data.escalatedCaseIds, query, filter, sort]);

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
        {/*
          The send switch moved to Overview.
          It gates every agent, not this one — `merchants.execution_enabled` is
          read by the abandoned-cart agent and the discount caller too — and
          sitting inside one agent's console it read as that agent's control
          while silently governing all three.
        */}
        <div className="exec">
          <div className="exec-label">
            <span className="exec-title">{live ? 'Live' : 'Paused'}</span>
            <span className="exec-sub">
              {live ? 'Messages reach real recipients' : 'Cases are held, nothing is sent'}
            </span>
          </div>
          <Link className="btn-ghost" href="/">
            Change on Overview
          </Link>
        </div>
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

      {mode === 'paused' && data.cases.length > 0 && (
        <div className="notice">
          <InfoIcon />
          <span>
            Paused. These cases keep their place, their deadline and their history, and nothing is
            sent. Switching to <strong style={{ fontWeight: 550 }}>Live</strong> starts them again
            from the step each one had reached.
          </span>
        </div>
      )}

      <NeedsAPerson
        escalations={data.escalations ?? []}
        alerts={data.alerts ?? []}
        ai={data.ai}
        cases={data.cases}
        onOpenCase={setOpenCase}
      />

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
          now={data.now}
          onStart={(id) => void start(id)}
          onOpen={setOpenCase}
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

      <Activity
        rows={data.activity}
        hasMore={data.activityHasMore ?? false}
        onOpenChange={(open) => {
          wantActivity.current = open;
          if (open) void refresh();
        }}
      />

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

      {openCase && (
        <CaseDrawer
          c={data.cases.find((x) => x.id === openCase.id) ?? openCase}
          escalation={(data.escalations ?? []).find((e) => e.caseId === openCase.id) ?? null}
          busy={busy}
          onAct={(id, action) => void actOnEscalation(id, action)}
          onClose={() => setOpenCase(null)}
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
    // The ladder stopped and handed these to a person. Distinct from
    // "Unreachable": that is a case we cannot contact, this is one we have
    // deliberately decided not to act on alone.
    { value: 'escalated', label: 'Needs a person' },
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
          <option value="newest">Newest first</option>
          <option value="amount">Largest first</option>
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
  now,
  onStart,
  onOpen,
  emptyReason,
}: {
  rows: RecoverableCase[];
  live: boolean;
  canStart: boolean;
  busy: string | null;
  now: string;
  onStart: (id: string) => void;
  onOpen: (c: RecoverableCase) => void;
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
    <div className="table-wrap table-scroll">
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
              now={now}
              onStart={() => onStart(c.id)}
              onOpen={() => onOpen(c)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Only the channels this system sends on. A `message_log` row naming anything
 * else is historical, and the lookup falls back to the raw value rather than
 * inventing a label for a channel the product no longer has.
 */
const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  email: 'Email',
};

const DECISION_COPY: Record<string, { verb: string; tone: 'progress' | 'done' | 'failed' | 'muted' }> = {
  diagnosed: { verb: 'Diagnosed', tone: 'muted' },
  rung_fired: { verb: 'Rung fired', tone: 'progress' },
  rung_deferred: { verb: 'Waiting', tone: 'muted' },
  rung_aborted: { verb: 'Stopped', tone: 'failed' },
  rung_abandoned: { verb: 'Abandoned', tone: 'failed' },
  rung_uncomposable: { verb: 'Could not compose', tone: 'failed' },
  // Muted, not failed. Nothing went wrong — the agent is paused and this case
  // is waiting, which is a different thing from a case that was stopped.
  rung_paused: { verb: 'Paused — held for resume', tone: 'muted' },
  ladder_paused: { verb: 'Paused — held for resume', tone: 'muted' },
  ladder_complete: { verb: 'Ladder complete', tone: 'done' },
  payment_link_created: { verb: 'Payment link created', tone: 'progress' },
  recovery_started: { verb: 'Recovery started', tone: 'progress' },
  state_changed: { verb: 'State changed', tone: 'muted' },
};

interface StepLine {
  text: string;
  detail: string | null;
  tone: 'progress' | 'done' | 'failed' | 'muted';
}

/**
 * The one-line "what is happening on this case" read.
 *
 * Pure lookup — the case's latest `message_log`/`case_events` row run through
 * the same copy tables the ladder detail page already uses, plus a template
 * for tense (queued reads as "Sending…", sent reads as "sent"). No model call,
 * no summarization: the data already says exactly what happened, this only
 * chooses which four words say it back.
 */
function stepLine(step: CaseStep): StepLine {
  if (step.kind === 'message') {
    const channel = CHANNEL_LABEL[step.channel ?? ''] ?? step.channel ?? 'Message';
    const detail = step.intent ? (INTENT_COPY[step.intent] ?? null) : null;

    if (step.suppressedReason) {
      const reason =
        step.suppressedReason === 'dry_run'
          ? 'dry run'
          : step.suppressedReason === 'holdout'
            ? 'holdout'
            : step.suppressedReason;
      return { text: `${channel} skipped — ${reason}`, detail, tone: 'muted' };
    }

    switch (step.status) {
      case 'queued':
        return { text: `Sending ${channel}…`, detail, tone: 'progress' };
      case 'sent':
        return { text: `${channel} sent`, detail, tone: 'done' };
      case 'delivered':
        return { text: `${channel} delivered`, detail, tone: 'done' };
      case 'read':
        return { text: `${channel} read`, detail, tone: 'done' };
      case 'failed':
        return { text: `${channel} failed`, detail, tone: 'failed' };
      default:
        return { text: `${channel} ${step.status ?? ''}`.trim(), detail, tone: 'muted' };
    }
  }

  const known = DECISION_COPY[step.event ?? ''];
  const verb = known?.verb ?? (step.event ?? 'Update').replace(/_/g, ' ');
  return { text: verb, detail: step.reason, tone: known?.tone ?? 'muted' };
}

const TONE_COLOR: Record<StepLine['tone'], string> = {
  progress: 'var(--data)',
  done: 'var(--good)',
  failed: 'var(--critical)',
  muted: 'var(--ink-muted)',
};

function StepBadge({ step, at }: { step: StepLine; at: Date }) {
  return (
    <div className="cell-main step-line" title={step.detail ?? undefined}>
      <span
        className={`dot${step.tone === 'progress' ? ' dot-pulse' : ''}`}
        style={{ background: TONE_COLOR[step.tone] }}
      />
      {step.text}
      <span className="cell-sub"> · {relativeTime(at)}</span>
    </div>
  );
}

/**
 * The drawer's forward-looking entry — the same fact `NextActionBadge` shows
 * on the row, in the trace's own `.rung` shape so it reads as the next line
 * of the same timeline rather than a separate widget bolted above it. A
 * hollow marker (`tone-upcoming`) rather than a filled one is the whole
 * distinction: everything below has happened, this has not — yet.
 */
function UpcomingRung({ next }: { next: PlannedStep }) {
  const [left, setLeft] = useState(() => new Date(next.at).getTime() - Date.now());

  useEffect(() => {
    const id = setInterval(() => setLeft(new Date(next.at).getTime() - Date.now()), 1000);
    return () => clearInterval(id);
  }, [next.at]);

  const channel = CHANNEL_LABEL[next.channel] ?? next.channel;
  const due = left <= 0;
  const detail = INTENT_COPY[next.intent] ?? null;

  return (
    <div className="rung">
      <div className="rung-at">{due ? 'now' : formatCountdown(left)}</div>
      <div className={`rung-body tone-${due ? 'progress' : 'upcoming'}`}>
        <div className="rung-title">
          {due ? `Sending ${channel}…` : `${channel} scheduled`}
        </div>
        {detail && <div className="rung-detail">{detail}</div>}
      </div>
    </div>
  );
}

function CaseRow({
  c,
  live,
  canStart,
  busy,
  now,
  onStart,
  onOpen,
}: {
  c: RecoverableCase;
  live: boolean;
  canStart: boolean;
  busy: boolean;
  now: string;
  onStart: () => void;
  onOpen: () => void;
}) {
  const blocked = c.optedOut || (!c.hasPhone && !c.hasEmail);
  const deadline = c.deadlineAt ? new Date(c.deadlineAt) : null;
  const hoursLeft = deadline ? (deadline.getTime() - new Date(now).getTime()) / 3_600_000 : null;
  const urgent = hoursLeft != null && hoursLeft < 6;
  // A message actually mid-flight — claimed but not yet resolved sent/failed,
  // or a scheduled follow-up whose time has come and is about to be picked up
  // on the next poll — is the one honest signal for "the system is working on
  // this case right now," as opposed to "this is what it last did."
  const nextDue = c.nextAction != null && new Date(c.nextAction.at).getTime() <= new Date(now).getTime();
  const working = (c.lastStep?.kind === 'message' && c.lastStep.status === 'queued') || nextDue;

  return (
    <tr
      className={`row-clickable${urgent ? ' row-urgent' : ''}${working ? ' row-active' : ''}`}
      onClick={onOpen}
      onMouseEnter={() => prefetchTrace(c.id)}
    >
      <td className="num amount-cell">
        <a href={`/cases/${c.id}`} onClick={(e) => e.stopPropagation()}>
          {inr(c.amountPaise)}
        </a>
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
        {c.nextAction ? (
          <NextActionBadge next={c.nextAction} />
        ) : c.lastStep ? (
          <StepBadge step={stepLine(c.lastStep)} at={new Date(c.lastStep.at)} />
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
          onClick={(e) => {
            e.stopPropagation();
            onStart();
          }}
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
/** `42` → "42s", `180` → "3m", `7200` → "2h", `172800` → "2d". Ceiling, never
 *  floor — a countdown that rounds down reads "0s" for several seconds
 *  before the thing it is counting down to actually happens. */
function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.ceil(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.ceil(h / 24)}d`;
}

/** The row's compact read of `c.nextAction` — live, ticking every second. */
function NextActionBadge({ next }: { next: PlannedStep }) {
  const [left, setLeft] = useState(() => new Date(next.at).getTime() - Date.now());

  useEffect(() => {
    const id = setInterval(() => setLeft(new Date(next.at).getTime() - Date.now()), 1000);
    return () => clearInterval(id);
  }, [next.at]);

  const channel = CHANNEL_LABEL[next.channel] ?? next.channel;
  if (left <= 0) return <span className="pill followup done">Sending {channel}…</span>;
  return (
    <span className="pill followup">
      {channel} in {formatCountdown(left)}
    </span>
  );
}

/* ── case drawer ─────────────────────────────────────────────────────────── */

/** Normalizes either half of `ActivityRow` into the shape `stepLine` reads,
 *  so the drawer's full trace and the row's single newest line always agree —
 *  they are the same function reading the same data at different lengths. */
function activityToStep(row: ActivityRow): CaseStep {
  if (row.kind === 'message') {
    return {
      at: row.at,
      kind: 'message',
      channel: row.channel,
      intent: row.intent,
      status: row.status,
      suppressedReason: row.suppressedReason,
      event: null,
      reason: null,
    };
  }
  return {
    at: row.at,
    kind: 'decision',
    channel: null,
    intent: null,
    status: null,
    suppressedReason: null,
    event: row.event,
    reason: row.reason,
  };
}

/**
 * Case traces, cached for the life of the page and de-duplicated in flight.
 *
 * Module-level, not component state: it needs to survive the drawer closing
 * and reopening, and a hover almost always precedes the click that opens it
 * by long enough to hide the network round trip entirely — by the time
 * someone actually clicks, the fetch a mouseenter started has often already
 * landed, so the drawer opens with its trace already in hand instead of a
 * spinner.
 */
const traceCache = new Map<string, ActivityRow[]>();
const traceInFlight = new Map<string, Promise<ActivityRow[] | null>>();

function fetchTrace(caseId: string): Promise<ActivityRow[] | null> {
  const inFlight = traceInFlight.get(caseId);
  if (inFlight) return inFlight;

  const request = fetch(`/api/recovery/case/${caseId}`, { cache: 'no-store' })
    .then((res) => res.json() as Promise<{ ok: boolean; trace?: ActivityRow[] }>)
    .then((json) => {
      if (!json.ok || !json.trace) return null;
      traceCache.set(caseId, json.trace);
      return json.trace;
    })
    .catch(() => null)
    .finally(() => {
      traceInFlight.delete(caseId);
    });

  traceInFlight.set(caseId, request);
  return request;
}

/** Fired on row hover. A no-op once the case is already cached or already loading. */
function prefetchTrace(caseId: string): void {
  if (traceCache.has(caseId)) return;
  void fetchTrace(caseId);
}

/**
 * One case, opened from its row: the full trace behind the row's single line.
 *
 * Reads `stepLine` over every entry in the case's history rather than just the
 * latest, so nothing shown here can disagree with the row it was opened from —
 * the row is a prefix of this list, not a different summary of it.
 */
function CaseDrawer({
  c,
  escalation,
  busy,
  onAct,
  onClose,
}: {
  c: RecoverableCase | null;
  escalation: ConsoleEscalation | null;
  busy: string | null;
  onAct: (id: string, action: 'acknowledge' | 'resolve' | 'dismiss') => void;
  onClose: () => void;
}) {
  const caseId = c?.id ?? null;
  const [trace, setTrace] = useState<ActivityRow[] | null>(() =>
    caseId ? (traceCache.get(caseId) ?? null) : null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!caseId) return;
    const thisCaseId = caseId;
    let cancelled = false;
    setTrace(traceCache.get(thisCaseId) ?? null);
    setLoadError(null);

    async function load() {
      const result = await fetchTrace(thisCaseId);
      if (cancelled) return;
      if (result) setTrace(result);
      else setLoadError('Could not load this case’s history. Retrying…');
    }

    void load();
    // Kept live while open with its own short poll — a case someone is
    // actually watching should update without them closing and reopening it,
    // but nothing here needs the main poll's 4s cadence tied to it.
    const intervalId = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [caseId]);

  useEffect(() => {
    if (!c) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [c, onClose]);

  if (!c) return null;

  const blocked = c.optedOut || (!c.hasPhone && !c.hasEmail);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${causeLabel(c.causeClass)}, ${inr(c.amountPaise)}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>

        <div className="drawer-head">
          <div className="eyebrow">{causeLabel(c.causeClass)}</div>
          <div className="drawer-amount">{inr(c.amountPaise, false)}</div>
          <p className="subtle" style={{ marginTop: 4, fontSize: 12.5 }}>
            <span className="mono">{c.errorReason}</span> · {c.method}
            {c.bank ? ` · ${c.bank}` : ''}
          </p>

          <div className="drawer-tags">
            <span className="pill">
              <span
                className="dot"
                style={{ background: blocked ? 'var(--critical)' : 'var(--good)' }}
              />
              {blocked ? (c.optedOut ? 'opted out' : 'unreachable') : 'reachable'}
            </span>
            {c.messagesSent > 0 && <span className="pill">{c.messagesSent} sent</span>}
            <span className="cell-sub">{c.emailMasked ?? c.phoneMasked ?? '—'}</span>
          </div>
        </div>

        {escalation && (
          <DrawerBrief escalation={escalation} busy={busy === escalation.id} onAct={onAct} />
        )}

        <div className="drawer-body">
          <h2 className="drawer-heading">What&rsquo;s happened</h2>

          <div className="ladder">
            {/* Instant, unlike the trace below — it comes straight off `c`,
                not a fetch, so "what's next" never waits behind a spinner. */}
            {c.nextAction && <UpcomingRung next={c.nextAction} />}

            {trace === null && loadError ? (
              <p className="subtle" style={{ fontSize: 13, color: 'var(--critical)' }}>
                {loadError}
              </p>
            ) : trace === null ? (
              <TraceSkeleton />
            ) : trace.length === 0 && !c.nextAction ? (
              <p className="subtle" style={{ fontSize: 13 }}>
                Diagnosed, not yet touched.
              </p>
            ) : (
              trace.map((row) => {
                const line = stepLine(activityToStep(row));
                return (
                  <div className="rung" key={row.id}>
                    <div className="rung-at">{relativeTime(new Date(row.at))}</div>
                    <div className={`rung-body tone-${line.tone}`}>
                      <div className="rung-title">{line.text}</div>
                      {line.detail && <div className="rung-detail">{line.detail}</div>}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="drawer-foot">
          <a href={`/cases/${c.id}`} className="link-btn">
            Open full case →
          </a>
        </div>
      </aside>
    </div>
  );
}

/**
 * The written brief, surfaced at the top of the case it belongs to.
 *
 * This used to live only in a standalone "Needs a person" panel, disconnected
 * from the case it was about. Reading it meant one screen; acting on the case
 * — starting a recovery, checking what had already been tried — meant another.
 * It belongs here instead: the brief IS about this case, so it sits above the
 * very trace it is summarising, and the same three actions that used to live
 * in the standalone card live here now, with nothing left behind to duplicate.
 */
function DrawerBrief({
  escalation,
  busy,
  onAct,
}: {
  escalation: ConsoleEscalation;
  busy: boolean;
  onAct: (id: string, action: 'acknowledge' | 'resolve' | 'dismiss') => void;
}) {
  return (
    <section className="drawer-brief">
      <div className="drawer-brief-head">
        <span className="pill">
          <span className="dot" style={{ background: 'var(--warning)' }} />
          Needs a person
        </span>
        <span className="brief-meta">
          {QUEUE_LABEL[escalation.queue] ?? escalation.queue} ·{' '}
          {relativeTime(new Date(escalation.createdAt))}
          {escalation.assignedTo ? ` · ${escalation.assignedTo}` : ''}
        </span>
      </div>

      <h3 className="drawer-brief-title">{escalation.headline}</h3>

      {escalation.whatHappened && (
        <p className="brief-body">
          <span className="brief-label">What happened</span>
          {escalation.whatHappened}
        </p>
      )}
      {escalation.whatWeTried && (
        <p className="brief-body">
          <span className="brief-label">What we tried</span>
          {escalation.whatWeTried}
        </p>
      )}
      {escalation.whatIsBlocking && (
        <p className="brief-body">
          <span className="brief-label">Blocking</span>
          {escalation.whatIsBlocking}
        </p>
      )}
      {escalation.recommendedAction && (
        <p className="brief-body">
          {/* Labelled every time: this is advice to the reader, and it must
              never read like an instruction the system is waiting to be given. */}
          <span className="brief-label">Suggestion — advice only</span>
          {escalation.recommendedAction}
        </p>
      )}

      <div className="brief-foot">
        <span
          className="pill"
          title={
            escalation.briefSource === 'claude'
              ? `Written by Claude${escalation.briefConfidence ? ` · ${escalation.briefConfidence} confidence` : ''}`
              : (escalation.briefError ?? 'Written without the model')
          }
        >
          <span
            className="dot"
            style={{
              background: escalation.briefSource === 'claude' ? 'var(--good)' : 'var(--ink-muted)',
            }}
          />
          {escalation.briefSource === 'claude'
            ? `Claude${escalation.briefConfidence ? ` · ${escalation.briefConfidence}` : ''}`
            : 'Fallback'}
        </span>

        <span style={{ flex: 1 }} />

        {escalation.status === 'open' && (
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() => onAct(escalation.id, 'acknowledge')}
          >
            Pick up
          </button>
        )}
        <button
          type="button"
          className="btn-ghost"
          disabled={busy}
          onClick={() => onAct(escalation.id, 'dismiss')}
          title="Looked, nothing to do"
        >
          Dismiss
        </button>
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={busy}
          onClick={() => onAct(escalation.id, 'resolve')}
        >
          {busy ? '…' : 'Resolve'}
        </button>
      </div>
    </section>
  );
}

/** A shimmering placeholder shaped like the trace it is about to become, so
 *  the eye has something to track instead of a blank second before content
 *  appears — reads as fast even when the network genuinely is not. */
function TraceSkeleton() {
  const widths = [62, 46, 74, 38];
  return (
    <div className="skeleton-trace" aria-hidden="true">
      {widths.map((w, i) => (
        <div className="skeleton-row" key={i}>
          <span className="skeleton-dot" />
          <span className="skeleton-bar" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
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
/* ── what needs a person ─────────────────────────────────────────────────── */

const QUEUE_LABEL: Record<string, string> = {
  merchant_review: 'Merchant review',
  risk_review: 'Risk review',
  ar_collections: 'Collections',
};

const SEVERITY_TONE: Record<string, string> = {
  critical: 'var(--critical)',
  warning: 'var(--warning)',
  info: 'var(--ink-muted)',
};

/**
 * The two things the agent produced that it is NOT allowed to act on alone:
 * cases handed to a person, and breakage a merchant has to decide about.
 *
 * Rendered ABOVE the case table and never collapsed away when non-empty, unlike
 * Activity. The distinction is what each panel is for — Activity is a trace you
 * consult, this is work that is waiting. A queue behind a closed disclosure is
 * a queue that gets ignored, which is the exact failure this replaced: before
 * it, `escalate_to_human` wrote a row that no screen in the product read.
 *
 * ── a queue, not a stack of full briefs ──
 *
 * This used to render the whole written brief inline, per item — sensible with
 * one escalation, unreadable with ten: the queue became a scroll of paragraphs
 * with the thing you actually came here for (which case needs me?) buried
 * between them. The brief now lives where it is actually about something — at
 * the top of that case's own drawer, see `DrawerBrief` — and this panel goes
 * back to being what a queue should be: one scannable line per item, click to
 * open the one you want. An alert has no single case to open into, so its row
 * stays informational rather than clickable.
 *
 * ── the provenance badge ──
 *
 * Every brief carries whether Claude wrote it or the deterministic fallback
 * did. That is not decoration. Every AI job here fails soft by design — an
 * unreachable model, an expired key, a rejected schema and a validation failure
 * all end in the same fallback, and the entry still appears. Without the badge,
 * a completely broken integration and a working one look identical from this
 * screen, and the queue would quietly stop being worth reading.
 */
function NeedsAPerson({
  escalations,
  alerts,
  ai,
  cases,
  onOpenCase,
}: {
  escalations: ConsoleEscalation[];
  alerts: ConsoleAlert[];
  ai?: AiHealth;
  cases: RecoverableCase[];
  onOpenCase: (c: RecoverableCase) => void;
}) {
  const total = escalations.length + alerts.length;
  // Nothing to show, nothing to say — a panel that exists only to announce
  // it has nothing in it is a line of chrome on every single load.
  if (total === 0) return null;

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panel-head">
        <span className="panel-title">
          Needs a person
          <span className="count-badge">{total}</span>
        </span>
        <AiBadge ai={ai} />
      </div>

      <div className="queue-list" style={{ maxHeight: 340, overflowY: 'auto' }}>
        {alerts.map((a) => (
          <div className="queue-row" key={a.id}>
            <span
              className="dot"
              style={{ background: SEVERITY_TONE[a.severity] ?? 'var(--ink-muted)' }}
            />
            <div className="queue-row-main">
              <div className="queue-row-title">{a.title}</div>
              <div className="queue-row-meta">
                {a.affectedCases} case{a.affectedCases === 1 ? '' : 's'} · {inr(a.amountPaise)} ·
                since {relativeTime(new Date(a.onsetAt))}
              </div>
            </div>
          </div>
        ))}

        {escalations.map((e) => {
          const matched = cases.find((c) => c.id === e.caseId);
          return (
            <button
              type="button"
              key={e.id}
              className="queue-row queue-row-clickable"
              disabled={!matched}
              title={matched ? undefined : 'This case is no longer open'}
              onClick={() => matched && onOpenCase(matched)}
            >
              <span className="dot" style={{ background: 'var(--warning)' }} />
              <div className="queue-row-main">
                <div className="queue-row-title">{e.headline}</div>
                <div className="queue-row-meta">
                  {QUEUE_LABEL[e.queue] ?? e.queue} · {inr(e.amountPaise)} ·{' '}
                  {causeLabel(e.causeClass)} · {relativeTime(new Date(e.createdAt))}
                </div>
              </div>
              <span
                className="pill"
                title={
                  e.briefSource === 'claude'
                    ? `Written by Claude${e.briefConfidence ? ` · ${e.briefConfidence} confidence` : ''}`
                    : (e.briefError ?? 'Written without the model')
                }
              >
                <span
                  className="dot"
                  style={{ background: e.briefSource === 'claude' ? 'var(--good)' : 'var(--ink-muted)' }}
                />
                {e.briefSource === 'claude' ? 'Claude' : 'Fallback'}
              </span>
              <ChevronIcon open={false} />
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Is the AI actually running?
 *
 * The honest answer without calling the API: how many briefs the model wrote
 * versus how many fell back, and the most recent reason one fell back. A run of
 * nothing but fallbacks is an expired key or a rejected request — both of which
 * are invisible everywhere else, because failing soft is the whole design.
 */
function AiBadge({ ai }: { ai?: AiHealth }) {
  if (!ai) return null;

  if (!ai.configured) {
    return (
      <span className="card-sub" title="Set ANTHROPIC_API_KEY to enable written briefs">
        AI off · briefs are deterministic
      </span>
    );
  }

  const total = ai.briefsByClaude + ai.briefsByFallback;
  if (total === 0) {
    return (
      <span className="card-sub" title="No case has escalated yet">
        AI on · nothing written yet
      </span>
    );
  }

  const broken = ai.briefsByClaude === 0;
  return (
    <span
      className="card-sub"
      style={broken ? { color: 'var(--critical)' } : undefined}
      title={ai.lastError ?? 'Most recent brief was written by Claude'}
    >
      {broken
        ? `AI configured but not writing — ${ai.lastError?.slice(0, 60) ?? 'every brief fell back'}`
        : `AI on · ${ai.briefsByClaude} written${ai.briefsByFallback > 0 ? `, ${ai.briefsByFallback} fell back` : ''}`}
    </span>
  );
}

/* ── activity ────────────────────────────────────────────────────────────── */

const LANES: { value: 'all' | ActivityCategory; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'message', label: 'Messages' },
  { value: 'ai', label: 'AI' },
  { value: 'decision', label: 'Decisions' },
  { value: 'system', label: 'System' },
];

const LANE_TONE: Record<ActivityCategory, string> = {
  message: 'var(--data)',
  ai: 'var(--good)',
  decision: 'var(--warning)',
  system: 'var(--ink-muted)',
};

/** What each event means, in words a person reads rather than a table name. */
const EVENT_COPY: Record<string, string> = {
  detected: 'Failure detected',
  diagnosed: 'Diagnosed',
  state_changed: 'State changed',
  payment_received: 'Payment received',
  aborted: 'Case aborted',
  ladder_complete: 'Ladder finished',
  recovery_started: 'Recovery started',
  rung_fired: 'Rung fired',
  rung_deferred: 'Waiting',
  rung_aborted: 'Stopped',
  rung_abandoned: 'Gave up on a rung',
  rung_uncomposable: 'Could not compose a message',
  payment_link_created: 'Payment link created',
  rung_paused: 'Held — agent paused',
  ladder_paused: 'Held — agent paused',
  escalated: 'Escalated to a person',
  merchant_alerted: 'Merchant alerted',
};

/**
 * Why a case ended, in words.
 *
 * The activity feed carries the machine's transition reason, and half of them
 * are only legible if you already know the state machine. `stale_after_pause`
 * in particular reads like an error and is not one — it is the system declining
 * to message someone about a payment they have long since forgotten.
 */
const REASON_COPY: Record<string, string> = {
  payment_received: 'the money arrived',
  already_paid: 'already paid',
  deadline_passed: 'the recovery window closed',
  ladder_exhausted: 'every step had been tried',
  customer_opted_out: 'the customer opted out',
  duplicate_case: 'a duplicate of another case',
  merchant_disconnected: 'the account was disconnected',
  manual_abort: 'stopped by a person',
  stale_after_pause: 'too old to message after the pause',
  paused_by_merchant: 'the agent was paused',
  resumed: 'the agent was resumed',
  resume_failed: 'could not be restarted — will retry',
  ladder_started: 'the ladder started',
  execution_paused: 'the agent is paused',
};

export function reasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return REASON_COPY[reason] ?? reason.replace(/_/g, ' ');
}

/** `2026-08-31` → `Today` / `Yesterday` / `31 Aug`. */
function dayLabel(d: Date, now: Date): string {
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

const clockTime = (d: Date) =>
  d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

/** One entry, normalised so the renderer does not branch on the row shape. */
interface Entry {
  id: string;
  at: Date;
  category: ActivityCategory;
  /** The headline. Four or five words. */
  title: string;
  /** The sentence under it, when there is one worth reading. */
  detail: string | null;
  /** Right-hand status word. */
  outcome: string | null;
  outcomeTone: string | null;
  caseId: string | null;
  actor: string | null;
}

function toEntry(r: ActivityRow): Entry {
  if (r.kind === 'message') {
    const channel = CHANNEL_LABEL[r.channel] ?? r.channel;
    return {
      id: r.id,
      at: new Date(r.at),
      category: 'message',
      title: `${channel} · ${INTENT_COPY[r.intent] ?? r.intent.replace(/_/g, ' ')}`,
      // The provider's own words when a send failed — already redacted at the
      // query layer, because Meta and Resend echo the recipient back inside
      // failure text.
      detail: r.error,
      outcome: r.suppressedReason ?? r.status,
      outcomeTone: r.suppressedReason
        ? 'var(--ink-muted)'
        : (STATUS_TONE[r.status] ?? 'var(--ink-muted)'),
      caseId: r.caseId,
      actor: null,
    };
  }

  return {
    id: r.id,
    at: new Date(r.at),
    category: r.category,
    title: EVENT_COPY[r.event] ?? r.event.replace(/_/g, ' '),
    /*
     * The gate's own sentence, kept whole.
     *
     * "already 2 message(s) in 24h (cap 2)" is the entire answer to "why did
     * nothing send"; paraphrasing it into a status word throws away the part
     * that tells you what to do, so `reasonLabel` passes anything it does not
     * recognise straight through. What it DOES translate is the state machine's
     * own vocabulary — `stale_after_pause` reads like an error and is not one.
     * `detail` carries the per-kind extras: which queue an escalation went to,
     * whether Claude wrote the brief.
     */
    detail: [reasonLabel(r.reason), r.detail].filter(Boolean).join(' · ') || null,
    outcome: r.retryAt ? `retry ${whenLabel(new Date(r.retryAt))}` : null,
    outcomeTone: 'var(--ink-muted)',
    caseId: r.caseId,
    actor: r.actor,
  };
}

/**
 * The audit trail.
 *
 * ── what changed, and why ──
 *
 * This was a five-column table of forty undifferentiated rows, fed by an
 * allowlist that silently dropped five of the fifteen event kinds the system
 * actually records — including `payment_received`, the moment money arrives,
 * and both events the Claude jobs write. An audit trail that omits the AI's own
 * actions is not an audit trail, and a wall of rows is not legible.
 *
 * So: complete underneath, narrow on demand. Every recorded event reaches this
 * component; the lane filter is how a reader asks a smaller question without
 * losing the guarantee that nothing was excluded. Entries group by day and
 * carry a fixed-width clock column, so scanning down finds a time rather than
 * re-reading a relative phrase on every line.
 *
 * ── on privacy ──
 *
 * The rendered message body is never selected from the database (see
 * `getRecentActivity`), and every free-text field is redacted at the query
 * layer rather than here. This component cannot leak a phone number, an email
 * or a payment link, because it is never given one.
 */
function Activity({
  rows,
  hasMore,
  onOpenChange,
  onOpenCase,
}: {
  rows: ActivityRow[];
  /** The ledger holds more than this page shows. See the header copy. */
  hasMore: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenCase?: (caseId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [lane, setLane] = useState<'all' | ActivityCategory>('all');

  const entries = useMemo(() => rows.map(toEntry), [rows]);
  const visible = useMemo(
    () => (lane === 'all' ? entries : entries.filter((e) => e.category === lane)),
    [entries, lane],
  );

  // Counts come from the FULL set, not the filtered one, so a lane that is
  // empty still says so rather than disappearing.
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: entries.length };
    for (const e of entries) c[e.category] = (c[e.category] ?? 0) + 1;
    return c;
  }, [entries]);

  const groups = useMemo(() => {
    const now = new Date();
    const out: { label: string; items: Entry[] }[] = [];
    for (const e of visible) {
      const label = dayLabel(e.at, now);
      const last = out.at(-1);
      if (last && last.label === label) last.items.push(e);
      else out.push({ label, items: [e] });
    }
    return out;
  }, [visible]);

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <button
        type="button"
        className="panel-head panel-toggle"
        onClick={() => {
          const next = !open;
          setOpen(next);
          onOpenChange(next);
        }}
        aria-expanded={open}
      >
        <span className="panel-title">
          <ChevronIcon open={open} />
          Activity
        </span>
        <span className="card-sub">
          {/*
            The count is `rows.length` and always was — never a constant — but
            the feed is capped, so at the cap it read "40 events · every action
            recorded" whether the ledger held forty rows or four thousand. A
            truncated page describing itself as complete is the one thing an
            audit trail must not do, so a capped page now says it is capped.
          */}
          {rows.length === 0
            ? 'nothing yet'
            : hasMore
              ? `latest ${rows.length} · older events not shown`
              : `${rows.length} event${rows.length === 1 ? '' : 's'} · every action recorded`}
        </span>
      </button>

      {open && rows.length === 0 && (
        <p className="subtle" style={{ fontSize: 13, padding: '0 16px 16px' }}>
          Nothing yet. Start a recovery above and every step — every message, every decision the
          gate made, everything Claude wrote — appears here.
        </p>
      )}

      {open && rows.length > 0 && (
        <>
          <div className="trail-lanes" role="group" aria-label="Filter activity">
            {LANES.map((l) => (
              <button
                key={l.value}
                type="button"
                aria-pressed={lane === l.value}
                className={`segment${lane === l.value ? ' segment-on' : ''}`}
                onClick={() => setLane(l.value)}
              >
                {l.value !== 'all' && (
                  <span className="dot" style={{ background: LANE_TONE[l.value] }} />
                )}
                {l.label}
                <span className="lane-count">{counts[l.value] ?? 0}</span>
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <p className="subtle" style={{ fontSize: 13, padding: '0 16px 16px' }}>
              Nothing in this lane yet.
            </p>
          ) : (
            <div className="trail">
              {groups.map((g) => (
                <div key={g.label}>
                  <div className="trail-day">{g.label}</div>
                  {g.items.map((e) => (
                    <div key={e.id} className="trail-row">
                      <time className="trail-time" dateTime={e.at.toISOString()}>
                        {clockTime(e.at)}
                      </time>
                      <span
                        className="trail-dot"
                        style={{ background: LANE_TONE[e.category] }}
                        aria-hidden="true"
                      />
                      <div className="trail-main">
                        <div className="trail-title">
                          {e.title}
                          {e.outcome && (
                            <span className="trail-outcome">
                              <span
                                className="dot"
                                style={{ background: e.outcomeTone ?? 'var(--ink-muted)' }}
                              />
                              {e.outcome}
                            </span>
                          )}
                        </div>
                        {e.detail && <div className="trail-detail">{e.detail}</div>}
                      </div>
                      <div className="trail-ref">
                        {e.actor && <span className="trail-actor">{e.actor}</span>}
                        {e.caseId &&
                          (onOpenCase ? (
                            <button
                              type="button"
                              className="trail-case"
                              onClick={() => onOpenCase(e.caseId!)}
                              title="Open this case"
                            >
                              {e.caseId.slice(0, 8)}
                            </button>
                          ) : (
                            <span className="trail-case">{e.caseId.slice(0, 8)}</span>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
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

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
