'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import type { MerchantOption } from '../lib/merchant-context';

const POLL_MS = 10_000;

/**
 * The account switcher.
 *
 * Shows the mode on the face of the control, not behind the menu. Which
 * account you are looking at and whether it can reach real customers are the
 * two facts that make every other number on the page mean something, so
 * neither is one click away.
 *
 * ── why this polls ──
 *
 * `current` and `all` arrive as server-rendered props, resolved once per
 * navigation. That is fine for the name and the id, which do not change under
 * you, and wrong for `mode` and `isLive` — Sandbox flipped Live→Paused from a
 * teammate's tab, or from this same tab a minute ago on `/recovery`, would sit
 * on screen showing the stale badge until something forced a reload. The
 * badge is the one thing on this control whose entire job is to be current, so
 * it is the one thing here backed by a poll rather than a prop.
 */
export function MerchantSwitcher({
  current: initialCurrent,
  all: initialAll,
}: {
  current: MerchantOption;
  all: MerchantOption[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [live, setLive] = useState(initialAll);
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);

  // The one thing overlaid onto the server-rendered props: which entry is
  // "current" still follows the cookie the layout already resolved, but its
  // mode and isLive are read from the poll so the face never shows a status
  // the account no longer has.
  const current = live.find((m) => m.slug === initialCurrent.slug) ?? initialCurrent;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/merchants/status', { cache: 'no-store' });
      if (!res.ok) return;
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; merchants?: MerchantOption[] };
      // Keyed merge, not a replace: the poll answers with every merchant this
      // user can see, in whatever order the query returns, and the switcher's
      // row order must not reshuffle itself under someone every ten seconds.
      if (json.ok && json.merchants) {
        const bySlug = new Map(json.merchants.map((m) => [m.slug, m]));
        setLive((prev) => prev.map((m) => bySlug.get(m.slug) ?? m));
      }
    } catch {
      // A missed poll leaves the badge exactly as stale as it already was —
      // never worse — and the next tick tries again.
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  /*
   * Re-baseline on a real navigation.
   *
   * `initialAll` only changes reference when the layout above this component
   * actually re-renders — a hard load, or the `router.refresh()` a merchant
   * switch triggers below — never on client-side navigation between pages
   * inside `(app)`, which keeps this component mounted and its poll running
   * uninterrupted. When it does change, the freshly resolved server list is
   * more authoritative than whatever the last poll merged in, so it wins.
   */
  useEffect(() => {
    setLive(initialAll);
  }, [initialAll]);

  // Close on an outside click or Escape — a menu that only closes on its own
  // toggle is a menu that stays open while you go do something else.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(slug: string) {
    setOpen(false);
    if (slug === current.slug) return;
    // A cookie rather than a query param: the selection has to survive
    // navigation to a case detail page and back.
    document.cookie = `vyavas_merchant=${slug}; path=/; max-age=31536000; samesite=lax`;
    startTransition(() => router.refresh());
  }

  return (
    <div className="switcher" data-open={open} ref={rootRef}>
      <button
        type="button"
        className="switcher-face"
        onClick={() => setOpen((v) => !v)}
        disabled={pending || live.length < 2}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="switcher-avatar" aria-hidden="true">
          {current.name.trim().charAt(0).toUpperCase()}
          <StatusDot mode={current.mode} isLive={current.isLive} />
        </span>
        <span className="switcher-text">
          <span className="switcher-name">{current.name}</span>
          <ModeDot mode={current.mode} isLive={current.isLive} />
        </span>
        {live.length > 1 && <ChevronIcon open={open} />}
      </button>

      {open && (
        <div className="switcher-menu" role="listbox">
          {live.map((m) => (
            <button
              key={m.slug}
              type="button"
              role="option"
              aria-selected={m.slug === current.slug}
              className={`switcher-item${m.slug === current.slug ? ' is-current' : ''}`}
              onClick={() => pick(m.slug)}
            >
              <span className="switcher-avatar switcher-avatar-sm" aria-hidden="true">
                {m.name.trim().charAt(0).toUpperCase()}
              </span>
              <span className="switcher-item-name">{m.name}</span>
              <ModeDot mode={m.mode} isLive={m.isLive} />
              {m.slug === current.slug && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const MODE_LABEL: Record<MerchantOption['mode'], string> = {
  paused: 'Paused',
  live: 'Live',
};

/**
 * Two facts in one pill: what the send mode is, and whether anything can reach
 * a real person. `live` sending with everything diverted is not the same risk
 * as `live` sending that goes out, and collapsing them is how someone clicks
 * Start on the wrong account. Built from the same dot-plus-word language every
 * status pill in this product uses, rather than its own solid-fill chip.
 */
function ModeDot({ mode, isLive }: { mode: MerchantOption['mode']; isLive: boolean }) {
  const danger = mode === 'live' && isLive;
  const tone = danger ? 'danger' : mode === 'live' ? 'live' : 'paused';
  return (
    <span className={`mode-pill mode-pill-${tone}`}>
      <span className="dot" />
      {MODE_LABEL[mode]}
      {danger && <span className="mode-pill-flag">real customers</span>}
    </span>
  );
}

/** The collapsed-rail twin of `ModeDot` — a notch on the avatar corner rather
 *  than a pill, since there is no width left at 68px to say the word. */
function StatusDot({ mode, isLive }: { mode: MerchantOption['mode']; isLive: boolean }) {
  const danger = mode === 'live' && isLive;
  const tone = danger ? ' is-danger' : mode === 'live' ? ' is-live' : '';
  return <span className={`switcher-status-dot${tone}`} aria-hidden="true" />;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="switcher-caret"
      style={{ transform: open ? 'rotate(180deg)' : 'none' }}
    >
      <path d="m4 6.5 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="switcher-check">
      <path d="m3.5 8.4 3 3 6-6.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
