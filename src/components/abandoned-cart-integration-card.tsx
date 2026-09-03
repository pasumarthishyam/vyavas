'use client';

import { useState } from 'react';

import { buildAiPrompt, buildCodeSnippet } from '../lib/abandoned-cart-integration';

type Tab = 'code' | 'prompt';
type Copied = 'endpoint' | 'key' | Tab | null;

/**
 * The setup box, matched to what it is actually used for: opened once, or
 * opened again to grab a value and paste it somewhere else.
 *
 * It was a 300px sticky aside pinned alongside the dashboard. That cost the
 * page a permanent third of its width for a task nobody repeats, and — more
 * concretely — it was the source of the page's horizontal overflow: a full
 * webhook URL and a bearer token do not fit in 300px, so the snippet scrolled
 * sideways inside a column that was itself too narrow for the grid it sat in.
 *
 * Now: a full-width panel at the foot of the page, collapsed by default. The
 * snippet gets the whole content width and wraps, so nothing here can push the
 * metrics above it sideways.
 */
export function AbandonedCartIntegrationCard({
  endpoint,
  apiKey: initialApiKey,
}: {
  endpoint: string;
  apiKey: string | null;
}) {
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [tab, setTab] = useState<Tab>('code');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState<Copied>(null);
  const [confirmingRegen, setConfirmingRegen] = useState(false);
  // Opens itself when there is no key yet — that is the one state where setup
  // is not "done once already", it is the next thing to do.
  const [open, setOpen] = useState(initialApiKey === null);

  async function copy(text: string, which: Copied) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1600);
    } catch {
      // A viewer that blocks clipboard access still has the raw text on
      // screen to select manually.
    }
  }

  async function regenerateKey() {
    setGenerating(true);
    try {
      const res = await fetch('/api/abandoned-cart/keys', { method: 'POST' });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; apiKey?: string };
      if (json.ok && json.apiKey) setApiKey(json.apiKey);
    } finally {
      setGenerating(false);
      setConfirmingRegen(false);
    }
  }

  const snippet = buildCodeSnippet({ endpoint, apiKey });
  const prompt = buildAiPrompt({ endpoint, apiKey });

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <button
        type="button"
        className={`panel-head panel-toggle${open ? ' panel-head-ruled' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="panel-title">
          <ChevronIcon open={open} />
          Connect your app
        </span>
        <span className="card-sub">
          {apiKey ? 'Endpoint, key and a snippet to paste' : 'No key yet — generate one to start'}
        </span>
      </button>

      {open && (
        <div className="connect-body">
          <div className="connect-fields">
            <FieldRow
              label="Endpoint"
              value={endpoint}
              copied={copied === 'endpoint'}
              onCopy={() => void copy(endpoint, 'endpoint')}
            />

            {apiKey ? (
              <FieldRow
                label="API key"
                value={apiKey}
                mask
                copied={copied === 'key'}
                onCopy={() => void copy(apiKey, 'key')}
              />
            ) : (
              <div className="subtle" style={{ fontSize: 12.5 }}>No key generated yet.</div>
            )}

            {confirmingRegen ? (
              <div className="connect-confirm">
                <span>Old key stops working immediately. Sure?</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirmingRegen(false)}>
                    Cancel
                  </button>
                  <button type="button" className="btn-primary btn-sm" disabled={generating} onClick={() => void regenerateKey()}>
                    {generating ? '…' : 'Confirm'}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setConfirmingRegen(true)}>
                {apiKey ? 'Regenerate key' : 'Generate key'}
              </button>
            )}

            {!apiKey ? (
              <div className="subtle" style={{ fontSize: 11.5 }}>
                Generate a key first — both boxes fill in once you do.
              </div>
            ) : null}
          </div>

          <div className="connect-snippet">
            <div className="segmented segmented-sm" style={{ marginBottom: 10 }}>
              <button type="button" className={`segment ${tab === 'code' ? 'segment-on' : ''}`} onClick={() => setTab('code')}>
                Code
              </button>
              <button type="button" className={`segment ${tab === 'prompt' ? 'segment-on' : ''}`} onClick={() => setTab('prompt')}>
                Prompt
              </button>
            </div>

            <div style={{ position: 'relative' }}>
              <pre className="mono connect-code">{tab === 'code' ? snippet : prompt}</pre>
              <button
                type="button"
                className="btn-ghost btn-sm connect-code-copy"
                onClick={() => void copy(tab === 'code' ? snippet : prompt, tab)}
              >
                {copied === tab ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
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
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform var(--t-fast) var(--ease)' }}
    >
      <path d="m6 3.5 5 4.5-5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FieldRow({
  label,
  value,
  mask,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  mask?: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  const display = mask ? `${value.slice(0, 12)}${'•'.repeat(10)}${value.slice(-4)}` : value;
  return (
    <div>
      <div className="subtle" style={{ fontSize: 11, marginBottom: 3 }}>{label}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <code className="mono connect-field" title={value}>{display}</code>
        <button type="button" className="btn-ghost btn-sm" onClick={onCopy} aria-label={`Copy ${label}`}>
          {copied ? '✓' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
