'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { PRESET_DAYS, type PresetDays } from '../lib/date-range';

export function DateRangeFilter({
  preset,
  customFrom,
  customTo,
}: {
  preset: PresetDays | null;
  customFrom: string | null;
  customTo: string | null;
}) {
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  // Open by default when a custom range is already active, so the dates the
  // user picked stay visible instead of collapsing behind the toggle.
  const [open, setOpen] = useState(preset === null);
  const [from, setFrom] = useState(customFrom ?? '');
  const [to, setTo] = useState(customTo ?? '');

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  function applyCustom(e: React.FormEvent) {
    e.preventDefault();
    if (!from || !to) return;
    router.push(`?from=${from}&to=${to}`);
  }

  return (
    <div className="date-filter" ref={panelRef}>
      <div className="date-filter-chips">
        {PRESET_DAYS.map((d) => (
          <Link
            key={d}
            href={`?days=${d}`}
            className="chip"
            aria-pressed={preset === d}
            scroll={false}
            onClick={() => setOpen(false)}
          >
            {d}d
          </Link>
        ))}
        <button type="button" className="chip" aria-pressed={preset === null} onClick={() => setOpen((v) => !v)}>
          Custom
        </button>
      </div>

      {open && (
        <form className="date-filter-panel" onSubmit={applyCustom}>
          <label className="date-filter-field">
            <span>From</span>
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              required
            />
          </label>
          <label className="date-filter-field">
            <span>To</span>
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              required
            />
          </label>
          <button type="submit" className="date-filter-apply">
            Apply
          </button>
        </form>
      )}
    </div>
  );
}
