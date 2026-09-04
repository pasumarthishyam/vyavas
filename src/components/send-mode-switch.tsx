'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { inr, maskPhone } from './ui';

/**
 * The one control that decides whether this account can message anybody.
 *
 * It lives on the Overview page, not on an agent's page, because it does not
 * belong to an agent. `merchants.execution_enabled` gates the failed-payment
 * ladder, the abandoned-cart agent and the discount caller alike — it was on
 * `/recovery` only for historical reasons, and sitting inside one agent's
 * console it read as that agent's switch while silently governing all three.
 *
 * ── going live asks first; pausing does not ──
 *
 * The asymmetry is the point. Pausing is safe and reversible: cases park in the
 * `paused` state keeping their rung, deadline and history, so making someone
 * confirm it would be friction with nothing behind it.
 *
 * Going live can put messages in front of real people the same second, and
 * after a long pause it can put a great many of them there at once, because
 * rung times are measured from when the payment failed rather than from when
 * the button was pressed. So it opens a preview and waits for a person.
 *
 * The dialog opens even when nothing is parked. Turning the agent on is the
 * moment it starts contacting customers, and the fact worth seeing before that
 * happens is WHERE those messages go — which an account with nothing waiting
 * still needs to be told.
 */

export type SendMode = 'paused' | 'live';

export interface RoutingSummary {
  whatsappRedirectTo: string | null;
  emailRedirectTo: string | null;
}

interface PausedCasePreview {
  id: string;
  amountPaise: number;
  customerContact: string | null;
  ageDays: number;
  disposition: 'resume' | 'too_old' | 'past_deadline';
  reason: string;
}

interface ResumePreview {
  paused: number;
  resumable: number;
  tooOld: number;
  pastDeadline: number;
  amountResumablePaise: number;
  amountClosingPaise: number;
  cases: PausedCasePreview[];
}

const EMPTY_PREVIEW: ResumePreview = {
  paused: 0,
  resumable: 0,
  tooOld: 0,
  pastDeadline: 0,
  amountResumablePaise: 0,
  amountClosingPaise: 0,
  cases: [],
};

const MODES: { value: SendMode; label: string; hint: string }[] = [
  { value: 'paused', label: 'Paused', hint: 'Cases are held, nothing is sent' },
  { value: 'live', label: 'Live', hint: 'Messages reach real recipients' },
];

export function SendModeSwitch({
  executionEnabled,
  routing,
  onChanged,
}: {
  executionEnabled: boolean;
  routing?: RoutingSummary;
  /**
   * Told what happened, for a host that shows its own notice.
   *
   * Optional: on a server-rendered page there is nothing to tell, and
   * `router.refresh()` below is what makes the new state visible.
   */
  onChanged?: (result: { mode: SendMode; resumed: number; closed: number }) => void;
}) {
  const [preview, setPreview] = useState<ResumePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const mode: SendMode = executionEnabled ? 'live' : 'paused';

  async function onChange(next: SendMode) {
    if (next === mode || busy) return;

    if (next === 'paused') {
      await commit('paused', 'none');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/recovery/execution', { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; preview?: ResumePreview };
      // A failed preview does not become a silent go-live: the dialog opens
      // with an empty one, so the decision is still a person's.
      setPreview(body.ok && body.preview ? body.preview : EMPTY_PREVIEW);
    } catch {
      setPreview(EMPTY_PREVIEW);
    } finally {
      setBusy(false);
    }
  }

  async function commit(next: SendMode, resume: 'resume' | 'none') {
    setBusy(true);
    try {
      const res = await fetch('/api/recovery/execution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next, resume }),
      });
      const body = (await res.json().catch(() => ({}))) as { resumed?: number; closed?: number };
      onChanged?.({ mode: next, resumed: body.resumed ?? 0, closed: body.closed ?? 0 });
    } finally {
      setPreview(null);
      setBusy(false);
      // The mode arrives as a server-rendered prop, so the new state is only
      // visible once the server re-renders. Hosts that poll their own state
      // still get this for free and simply re-render with what they already had.
      router.refresh();
    }
  }

  const active = MODES.find((m) => m.value === mode) ?? MODES[0]!;

  return (
    <>
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
              disabled={busy}
              className={`segment${mode === m.value ? ' segment-on' : ''}${m.value === 'live' && mode === 'live' ? ' segment-live' : ''}`}
              onClick={() => void onChange(m.value)}
              title={m.hint}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {preview && (
        <ResumeOverlay
          preview={preview}
          routing={routing}
          busy={busy}
          onCancel={() => setPreview(null)}
          onConfirm={(choice) => void commit('live', choice)}
        />
      )}
    </>
  );
}

/**
 * What happens when the agent comes back on.
 *
 * The numbers come first and the buttons come second, and the destructive
 * reading of each button is written on its face rather than implied. Too-old
 * and past-deadline cases are closed on either path, because there is no choice
 * to offer about them — a message about a five-day-old checkout is not an
 * option that was withheld, it is one that does not exist.
 */
function ResumeOverlay({
  preview,
  routing,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: ResumePreview;
  routing?: RoutingSummary;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (choice: 'resume' | 'none') => void;
}) {
  const closing = preview.tooOld + preview.pastDeadline;
  const nothingWaiting = preview.paused === 0;

  const waDiverted = Boolean(routing?.whatsappRedirectTo);
  const mailDiverted = Boolean(routing?.emailRedirectTo);
  const reachesRealPeople = Boolean(routing) && (!waDiverted || !mailDiverted);

  return (
    <div className="drawer-backdrop" onClick={busy ? undefined : onCancel}>
      <div
        className="resume-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resume-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="resume-head">
          <h2 id="resume-title" className="resume-title">
            {nothingWaiting
              ? 'Turn the agent on?'
              : `${preview.paused} case${preview.paused === 1 ? '' : 's'} ${preview.paused === 1 ? 'is' : 'are'} waiting`}
          </h2>
          <p className="resume-sub">
            {nothingWaiting
              ? 'It will act on new failures from this point. Nothing has changed yet.'
              : 'Turning the agent on decides what happens to each of them. Nothing has changed yet.'}
          </p>
        </div>

        {/* Never colour alone: the sentence says where messages go, and the
            critical tint only reinforces it. */}
        <div className={`resume-routing${reachesRealPeople ? ' resume-routing-live' : ''}`}>
          {routing ? (
            <>
              <strong style={{ fontWeight: 550 }}>WhatsApp</strong>{' '}
              {waDiverted ? (
                <>
                  → <span className="mono">+{maskPhone(routing.whatsappRedirectTo!)}</span>
                </>
              ) : (
                <>→ the real customer number</>
              )}
              {' · '}
              <strong style={{ fontWeight: 550 }}>Email</strong>{' '}
              {mailDiverted ? (
                <>
                  → <span className="mono">{routing.emailRedirectTo}</span>
                </>
              ) : (
                <>→ the real customer address</>
              )}
              {reachesRealPeople && ' — these reach real people.'}
            </>
          ) : (
            <>Message routing for this account is unknown.</>
          )}
        </div>

        {!nothingWaiting && (
          <div className="resume-split">
            <div className="resume-bucket">
              <div className="resume-count">{preview.resumable}</div>
              <div className="resume-bucket-label">will be messaged</div>
              <div className="resume-bucket-foot">
                {inr(preview.amountResumablePaise)} · picks up where each one stopped
              </div>
            </div>
            <div className="resume-bucket resume-bucket-muted">
              <div className="resume-count">{closing}</div>
              <div className="resume-bucket-label">will be closed, not messaged</div>
              <div className="resume-bucket-foot">
                {inr(preview.amountClosingPaise)}
                {preview.tooOld > 0 && ` · ${preview.tooOld} too old`}
                {preview.pastDeadline > 0 && ` · ${preview.pastDeadline} past deadline`}
              </div>
            </div>
          </div>
        )}

        {closing > 0 && (
          <p className="resume-note">
            A message has to be about something the person still remembers doing. These are past
            that, so they are closed rather than sent on either choice below.
          </p>
        )}

        {preview.cases.length > 0 && (
          <div className="resume-list">
            {preview.cases.slice(0, 40).map((c) => (
              <div key={c.id} className="resume-row">
                <span
                  className="dot"
                  style={{
                    background: c.disposition === 'resume' ? 'var(--data)' : 'var(--ink-muted)',
                  }}
                />
                <span className="resume-row-amount">{inr(c.amountPaise)}</span>
                <span className="resume-row-who">{c.customerContact ?? 'no contact'}</span>
                <span className="resume-row-why">{c.reason}</span>
              </div>
            ))}
            {preview.cases.length > 40 && (
              <div className="resume-row resume-row-more">
                and {preview.cases.length - 40} more
              </div>
            )}
          </div>
        )}

        <div className="resume-actions">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>
            Stay paused
          </button>
          {/* Offered only when there is somebody waiting. With nothing parked it
              is the same act as the primary button, and two buttons that do the
              same thing make a person hunt for the difference. */}
          {!nothingWaiting && (
            <button
              className="btn-ghost"
              onClick={() => onConfirm('none')}
              disabled={busy}
              title="The agent handles new failures from now on. Everyone currently waiting is closed without being contacted."
            >
              Go live, contact nobody waiting
            </button>
          )}
          <button className="btn-primary" onClick={() => onConfirm('resume')} disabled={busy}>
            {busy
              ? 'Working…'
              : preview.resumable > 0
                ? `Go live and resume ${preview.resumable}`
                : 'Go live'}
          </button>
        </div>
      </div>
    </div>
  );
}
