'use client';

import { useEffect, useState } from 'react';

/**
 * The vocabulary the Cases table uses without defining.
 *
 * Every column on that page is a word with a specific meaning here — "lost" is
 * not a guess, "holdout" is not a status — and the page previously explained
 * exactly one of them, in a paragraph under the table that most readers scroll
 * past. This is the whole vocabulary instead: docked bottom-right, out of the
 * way, one line per term, opened only when someone actually wants it.
 *
 * Deliberately not a tooltip on each cell: the question this answers is "what
 * are all these words", asked once, not "what is this one cell".
 */

interface Term {
  term: string;
  def: string;
  color: string;
}

const STATES: Term[] = [
  { term: 'Detected', def: 'A failed payment arrived. Nothing decided yet.', color: 'var(--ink-muted)' },
  { term: 'Diagnosed', def: 'We know why it failed and what to try.', color: 'var(--data)' },
  { term: 'Executing', def: 'The agent is working the case right now.', color: 'var(--data)' },
  { term: 'Paused', def: 'Stopped for a person to look at.', color: 'var(--warning)' },
  { term: 'Recovered', def: 'The customer paid. Money is back.', color: 'var(--good)' },
  { term: 'Lost / Written off', def: 'The deadline passed unpaid. We stopped trying.', color: 'var(--critical)' },
  { term: 'Aborted', def: 'Closed without trying — already paid, or nothing to recover.', color: 'var(--ink-muted)' },
];

const GROUPS: Term[] = [
  { term: 'Treatment', def: 'Normal. The agent contacts the customer.', color: 'var(--data)' },
  { term: 'Holdout', def: 'Everything runs and is logged, but nothing is sent.', color: 'var(--ink-muted)' },
];

const WHY: Term[] = [
  {
    term: 'Why a holdout?',
    def: 'Some customers pay anyway. The gap between the two groups is what recovery actually earned.',
    color: 'var(--ink-muted)',
  },
];

export function CasesLegend() {
  const [open, setOpen] = useState(false);

  // Escape closes, like every other transient surface in the product.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="legend-dock">
      {open && (
        <div className="legend-panel" role="dialog" aria-label="What these words mean">
          <div className="legend-head">
            <span className="legend-title">What these words mean</span>
            <button
              type="button"
              className="legend-close"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          </div>

          <div className="legend-body">
            <Group label="Case state" terms={STATES} />
            <Group label="Group" terms={GROUPS} />
            <Group label="Why" terms={WHY} />
          </div>
        </div>
      )}

      <button
        type="button"
        className="legend-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <HelpIcon />
        {open ? 'Hide key' : 'What do these mean?'}
      </button>
    </div>
  );
}

function Group({ label, terms }: { label: string; terms: Term[] }) {
  return (
    <div className="legend-group">
      <div className="legend-group-label">{label}</div>
      {terms.map((t) => (
        <div className="legend-item" key={t.term}>
          <span className="dot" style={{ background: t.color }} />
          <div>
            <div className="legend-term">{t.term}</div>
            <div className="legend-def">{t.def}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function HelpIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M6.4 6.3a1.7 1.7 0 1 1 2.2 1.6c-.4.2-.6.5-.6.9v.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="M8 11.6h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
