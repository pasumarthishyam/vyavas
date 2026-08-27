'use client';

import { useState } from 'react';
import { formatINR, type Paise } from '../core/money';

/*
 * Charts.
 *
 * Inline SVG and CSS, no charting library — full control over the marks, and
 * nothing to load. Every form here follows the same rules:
 *
 *   - Magnitude gets ONE hue. Cause classes and banks are nominal categories,
 *     so darkening a bar by its own value would double-encode length as colour
 *     and burn the only free channel on information the bar already shows.
 *   - The heatmap is the exception, and legitimately so: a grid of continuous
 *     magnitude is what a sequential ramp is for.
 *   - Thin marks, hairline grid, 4px rounded data-ends, 2px surface gaps.
 *   - Values are direct-labelled selectively; the tooltip carries the rest.
 */

const inr = (p: number) => formatINR(p as Paise, { compact: true });

// ─── bars: magnitude across nominal categories ───────────────────────────────

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  meta?: string;
  href?: string;
}

export function Bars({ data, emptyLabel }: { data: BarDatum[]; emptyLabel: string }) {
  if (data.length === 0) return <Empty title="Nothing yet" body={emptyLabel} />;

  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="bars">
      {data.map((d) => (
        <div className="bar-row" key={d.key} title={`${d.label} · ${inr(d.value)}`}>
          <div className="bar-name">{d.label}</div>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ width: `${Math.max((d.value / max) * 100, 1.5)}%` }}
            />
          </div>
          <div className="bar-value">{inr(d.value)}</div>
        </div>
      ))}
    </div>
  );
}

// ─── trend: one series over time ─────────────────────────────────────────────

export interface TrendDatum {
  date: string;
  value: number;
  secondary?: number;
  cases?: number;
}

export function Trend({ data, height = 168 }: { data: TrendDatum[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);

  if (data.length < 2) {
    return <Empty title="Not enough history" body="A trend needs at least two days of data." />;
  }

  const W = 1000;
  const H = height;
  const padTop = 12;
  const padBottom = 6;
  const max = Math.max(...data.map((d) => d.value), 1);
  const plotH = H - padTop - padBottom;

  const x = (i: number) => (i / (data.length - 1)) * W;
  const y = (v: number) => padTop + plotH - (v / max) * plotH;

  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(d.value)}`).join(' ');
  const area = `${line} L${W},${H - padBottom} L0,${H - padBottom} Z`;

  const active = hover != null ? data[hover] : null;

  return (
    <div className="trend-wrap">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height, display: 'block', overflow: 'visible' }}
        role="img"
        aria-label={`Revenue at risk over ${data.length} days`}
        onMouseLeave={() => setHover(null)}
      >
        {/* recessive hairline grid — solid, never dashed */}
        {[0.5, 1].map((f) => (
          <line
            key={f}
            x1={0}
            x2={W}
            y1={padTop + plotH * (1 - f)}
            y2={padTop + plotH * (1 - f)}
            stroke="var(--grid)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* area fill at ~10% — a wash, never a saturated block */}
        <path d={area} fill="var(--data)" opacity={0.1} />
        <path
          d={line}
          fill="none"
          stroke="var(--data)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {active && hover != null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={padTop}
              y2={H - padBottom}
              stroke="var(--baseline)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            {/* 2px surface ring keeps the marker legible over the line */}
            <circle
              cx={x(hover)}
              cy={y(active.value)}
              r={5}
              fill="var(--data)"
              stroke="var(--surface)"
              strokeWidth={2.5}
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}

        {/* Hit targets far wider than the marks — a 2px line is impossible to land on. */}
        {data.map((_, i) => (
          <rect
            key={i}
            x={x(i) - W / data.length / 2}
            y={0}
            width={W / data.length}
            height={H}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>

      <div className="trend-axis">
        <span>{formatDay(data[0]!.date)}</span>
        {active ? (
          <span style={{ color: 'var(--ink)', fontWeight: 500 }}>
            {formatDay(active.date)} · {inr(active.value)}
            {active.cases != null ? ` · ${active.cases} case${active.cases === 1 ? '' : 's'}` : ''}
          </span>
        ) : (
          <span>{data.length} days</span>
        )}
        <span>{formatDay(data[data.length - 1]!.date)}</span>
      </div>

      {/*
        The table-view twin. A tooltip may enhance a chart but must never be the
        only way to reach a value — hover does not exist for a keyboard or a
        screen reader, and the crosshair readout above is hover-gated.
      */}
      <table className="sr-only">
        <caption>Revenue at risk by day</caption>
        <thead>
          <tr>
            <th>Date</th>
            <th>Amount at risk</th>
            <th>Cases</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td>
              <td>{inr(d.value)}</td>
              <td>{d.cases ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ─── heatmap: continuous magnitude on a grid ─────────────────────────────────

export interface HeatDatum {
  row: string;
  col: string;
  value: number;
  cases: number;
}

const RAMP = [
  'var(--seq-100)',
  'var(--seq-200)',
  'var(--seq-300)',
  'var(--seq-400)',
  'var(--seq-500)',
  'var(--seq-600)',
  'var(--seq-700)',
];

export function Heatmap({ data }: { data: HeatDatum[] }) {
  if (data.length === 0) {
    return <Empty title="Nothing yet" body="No failures recorded in this window." />;
  }

  const rows = [...new Set(data.map((d) => d.row))];
  const cols = [...new Set(data.map((d) => d.col))].slice(0, 8);
  const lookup = new Map(data.map((d) => [`${d.row}|${d.col}`, d]));
  const max = Math.max(...data.map((d) => d.value), 1);

  // Square-root scaling: on a linear ramp one very large cell flattens every
  // other cell to the palest step and the grid stops saying anything.
  const stepFor = (v: number) => {
    if (v <= 0) return -1;
    const t = Math.sqrt(v / max);
    return Math.min(RAMP.length - 1, Math.floor(t * RAMP.length));
  };

  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table className="heat">
          <thead>
            <tr>
              <th className="row-head" />
              {cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r}>
                <th className="row-head">{prettyMethod(r)}</th>
                {cols.map((c) => {
                  const cell = lookup.get(`${r}|${c}`);
                  const step = cell ? stepFor(cell.value) : -1;
                  const filled = step >= 0;
                  return (
                    <td
                      key={c}
                      className={filled ? 'filled' : undefined}
                      style={
                        filled
                          ? { background: RAMP[step], color: `var(--seq-ink-${step})` }
                          : undefined
                      }
                      title={
                        cell
                          ? `${prettyMethod(r)} · ${c} — ${inr(cell.value)} across ${cell.cases} case${cell.cases === 1 ? '' : 's'}`
                          : `${prettyMethod(r)} · ${c} — none`
                      }
                    >
                      {cell ? cell.cases : '·'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="heat-legend">
        <span>Fewer</span>
        <div className="heat-swatches">
          {RAMP.map((c) => (
            <div key={c} className="heat-swatch" style={{ background: c }} />
          ))}
        </div>
        <span>More failures</span>
        <span style={{ marginLeft: 'auto' }}>Cell shows case count; hover for value.</span>
      </div>
    </div>
  );
}

function prettyMethod(m: string): string {
  const map: Record<string, string> = {
    card: 'Card',
    upi: 'UPI',
    netbanking: 'Netbanking',
    wallet: 'Wallet',
    emi: 'EMI',
    cardless_emi: 'Cardless EMI',
    paylater: 'Pay later',
    bank_transfer: 'Bank transfer',
    nach: 'NACH',
    unknown: 'Unknown',
  };
  return map[m] ?? m;
}

// ─── shared ──────────────────────────────────────────────────────────────────

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <div className="empty-body">{body}</div>
    </div>
  );
}
