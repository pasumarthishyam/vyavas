'use client';

import { useState } from 'react';

import { buildAiPrompt, buildCodeSnippet } from '../lib/abandoned-cart-integration';

type Tab = 'code' | 'prompt';
type Copied = 'endpoint' | 'key' | Tab | null;

/**
 * The setup box, redesigned to match what it is actually used for: this gets
 * opened once, or to grab a value and paste it somewhere else. Every field
 * here exists to be copied, not read, so the whole card stays a fixed-width
 * column that sits beside the dashboard rather than interrupting it.
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
    <aside className="card connect-card">
      <div className="panel-head">
        <span className="panel-title">Connect your app</span>
      </div>

      <div className="connect-body">
        <FieldRow label="Endpoint" value={endpoint} copied={copied === 'endpoint'} onCopy={() => void copy(endpoint, 'endpoint')} />

        {apiKey ? (
          <FieldRow label="API key" value={apiKey} mask copied={copied === 'key'} onCopy={() => void copy(apiKey, 'key')} />
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

        <div className="segmented segmented-sm" style={{ marginTop: 4 }}>
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

        {!apiKey ? (
          <div className="subtle" style={{ fontSize: 11.5 }}>Generate a key first — both boxes fill in once you do.</div>
        ) : null}
      </div>
    </aside>
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
