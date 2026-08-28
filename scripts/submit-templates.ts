/**
 * Submit the message templates to Meta for review.
 *
 *   npm run templates:status    what Meta currently has
 *   npm run templates:submit    create anything missing
 *
 * Templates live in `src/messaging/templates.ts` as the single source of truth.
 * This pushes them to the WhatsApp Business Account and reports approval status.
 *
 * Idempotent: a template Meta already has is skipped, never resubmitted. Meta
 * rejects a duplicate name outright, and more importantly an APPROVED template
 * that gets edited drops back to PENDING — so a careless re-run would take the
 * whole ladder offline until review passes again.
 */

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv();

import { TEMPLATES, placeholderCount, type TemplateDefinition } from '../src/messaging/templates.js';
import {
  requireWhatsAppBusinessAccountId,
  requireWhatsAppConfig,
} from '../src/lib/env.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

interface MetaTemplate {
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
  rejected_reason?: string;
}

async function listRemote(waba: string, token: string): Promise<MetaTemplate[]> {
  const out: MetaTemplate[] = [];
  let url = `${GRAPH}/${waba}/message_templates?limit=100&fields=name,status,category,language,rejected_reason`;

  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json()) as {
      data?: MetaTemplate[];
      paging?: { next?: string };
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
    out.push(...(json.data ?? []));
    url = json.paging?.next ?? '';
  }
  return out;
}

/**
 * Validate before sending.
 *
 * Meta's rejection messages are terse and arrive minutes later. Catching these
 * locally turns a slow, vague round trip into an immediate, specific one.
 */
function validate(t: TemplateDefinition): string[] {
  const problems: string[] = [];

  if (!/^[a-z0-9_]+$/.test(t.name)) {
    problems.push('name must be lowercase letters, digits and underscores only');
  }
  const count = placeholderCount(t.body);
  if (count !== t.variables.length) {
    problems.push(`body has ${count} placeholder(s) but ${t.variables.length} variable role(s)`);
  }
  if (t.examples.length !== t.variables.length) {
    problems.push(`needs ${t.variables.length} example value(s), has ${t.examples.length}`);
  }
  if (/^\s*\{\{/.test(t.body)) problems.push('body may not START with a variable');
  if (/\}\}\s*$/.test(t.body)) problems.push('body may not END with a variable');
  if (t.body.length > 1024) problems.push('body exceeds 1024 characters');

  // Numbering must be 1..n with no gaps, or Meta rejects the parameter mapping.
  const used = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const expected = Array.from({ length: t.variables.length }, (_, i) => i + 1);
  if ([...new Set(used)].sort((a, b) => a - b).join(',') !== expected.join(',')) {
    problems.push(`placeholders must be numbered 1..${t.variables.length} with no gaps`);
  }

  return problems;
}

async function submit(
  waba: string,
  token: string,
  t: TemplateDefinition,
): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`${GRAPH}/${waba}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: t.name,
      category: t.category,
      language: t.language,
      components: [
        {
          type: 'BODY',
          text: t.body,
          example: { body_text: [t.examples] },
        },
      ],
    }),
  });

  const json = (await res.json()) as {
    id?: string;
    status?: string;
    error?: { message?: string; error_user_msg?: string };
  };

  return res.ok && json.id
    ? { ok: true, detail: `${json.status ?? 'PENDING'} (${json.id})` }
    : {
        ok: false,
        detail: json.error?.error_user_msg ?? json.error?.message ?? `HTTP ${res.status}`,
      };
}

async function main(): Promise<void> {
  const doSubmit = process.argv.includes('--submit');
  const { accessToken } = requireWhatsAppConfig();
  const waba = requireWhatsAppBusinessAccountId();

  // Fail on a malformed template before touching the network.
  let invalid = 0;
  for (const t of TEMPLATES) {
    const problems = validate(t);
    if (problems.length > 0) {
      invalid++;
      console.error(`\n  INVALID  ${t.name}`);
      for (const p of problems) console.error(`           - ${p}`);
    }
  }
  if (invalid > 0) {
    console.error(`\n${invalid} template(s) failed local validation. Nothing was submitted.\n`);
    process.exit(1);
  }

  const remote = await listRemote(waba, accessToken);
  const byName = new Map(remote.map((r) => [r.name, r]));

  console.log(`\n  WhatsApp Business Account ${waba}`);
  console.log(`  ${TEMPLATES.length} template(s) defined · ${remote.length} on Meta\n`);

  let created = 0;
  let failed = 0;

  for (const t of TEMPLATES) {
    const existing = byName.get(t.name);

    if (existing) {
      const flag =
        existing.status === 'APPROVED' ? 'ok      ' : existing.status === 'REJECTED' ? 'REJECTED' : 'pending ';
      console.log(`  ${flag} ${t.name.padEnd(36)} ${existing.status}`);
      if (existing.rejected_reason && existing.rejected_reason !== 'NONE') {
        console.log(`           reason: ${existing.rejected_reason}`);
      }
      continue;
    }

    if (!doSubmit) {
      console.log(`  MISSING  ${t.name.padEnd(36)} (run with --submit to create)`);
      continue;
    }

    const r = await submit(waba, accessToken, t);
    if (r.ok) {
      created++;
      console.log(`  created  ${t.name.padEnd(36)} ${r.detail}`);
    } else {
      failed++;
      console.log(`  FAILED   ${t.name.padEnd(36)} ${r.detail}`);
    }
  }

  const approved = TEMPLATES.filter((t) => byName.get(t.name)?.status === 'APPROVED').length;

  console.log(`\n  ${approved}/${TEMPLATES.length} approved and sendable`);
  if (created > 0) {
    console.log(`  ${created} submitted — utility templates usually review in minutes.`);
    console.log('  Re-run npm run templates:status to check.');
  }
  if (failed > 0) console.log(`  ${failed} failed to submit.`);
  console.log('');
}

void main();
