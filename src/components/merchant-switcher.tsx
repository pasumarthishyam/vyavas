'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import type { MerchantOption } from '../lib/merchant-context';

/**
 * The account switcher.
 *
 * Shows the mode on the face of the control, not behind the menu. Which
 * account you are looking at and whether it can reach real customers are the
 * two facts that make every other number on the page mean something, so
 * neither is one click away.
 */
export function MerchantSwitcher({
  current,
  all,
}: {
  current: MerchantOption;
  all: MerchantOption[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function pick(slug: string) {
    setOpen(false);
    if (slug === current.slug) return;
    // A cookie rather than a query param: the selection has to survive
    // navigation to a case detail page and back.
    document.cookie = `vyavas_merchant=${slug}; path=/; max-age=31536000; samesite=lax`;
    startTransition(() => router.refresh());
  }

  return (
    <div className="switcher" data-open={open}>
      <button
        type="button"
        className="switcher-face"
        onClick={() => setOpen((v) => !v)}
        disabled={pending || all.length < 2}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="switcher-name">{current.name}</span>
        <ModeDot mode={current.mode} isLive={current.isLive} />
        {all.length > 1 && <span className="switcher-caret">▾</span>}
      </button>

      {open && (
        <div className="switcher-menu" role="listbox">
          {all.map((m) => (
            <button
              key={m.slug}
              type="button"
              role="option"
              aria-selected={m.slug === current.slug}
              className={`switcher-item${m.slug === current.slug ? ' is-current' : ''}`}
              onClick={() => pick(m.slug)}
            >
              <span className="switcher-item-name">{m.name}</span>
              <ModeDot mode={m.mode} isLive={m.isLive} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const MODE_LABEL: Record<MerchantOption['mode'], string> = {
  off: 'Off',
  dry_run: 'Dry run',
  live: 'Live',
};

/**
 * Two facts in one chip: what the send mode is, and whether anything can reach
 * a real person. `live` sending with everything diverted is not the same risk
 * as `live` sending that goes out, and collapsing them is how someone clicks
 * Start on the wrong account.
 */
function ModeDot({ mode, isLive }: { mode: MerchantOption['mode']; isLive: boolean }) {
  const danger = mode === 'live' && isLive;
  return (
    <span className={`mode-chip mode-${mode}${danger ? ' mode-danger' : ''}`}>
      {MODE_LABEL[mode]}
      {danger && <span className="mode-chip-flag">· real customers</span>}
    </span>
  );
}
