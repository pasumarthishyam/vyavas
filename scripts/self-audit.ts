/**
 * The agent's self-audit.
 *
 *   npm run audit
 *   npm run audit -- --days=30
 *   npm run audit -- --merchant=<uuid>
 *   npm run audit -- --no-ai        (buckets only, no model call)
 *
 * Answers the question the dashboard cannot: which cases did we lose WITHOUT
 * THE AGENT EVER ACTING, and why?
 *
 * Those are the fixable losses. A customer who got three good messages and did
 * not pay is a customer who did not want to pay. A case that sent nothing
 * because its payment link could not be composed is a bug with a price on it,
 * and nothing else in this system surfaces it.
 *
 * Read-only. It writes nothing.
 */

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv();

import { createClient } from '../src/db/client.js';
import { formatINR, type Paise } from '../src/core/money.js';
import { runSelfAudit } from '../src/ops/self-audit.js';
import { die, flag } from './lib.js';

const inr = (p: number) => formatINR(p as Paise, { compact: true });

const SEVERITY_MARK: Record<string, string> = {
  critical: '!!',
  high: ' !',
  medium: ' ·',
  low: '  ',
};

async function main(): Promise<void> {
  const days = Number(flag('days') ?? 7);
  const merchantId = flag('merchant');
  const skipAnalysis = process.argv.includes('--no-ai');

  // A long-lived script, not a serverless invocation: a small pool and a
  // generous query budget, because these aggregates scan a lot more than a
  // request ever does.
  const { db, sql: raw } = createClient({ max: 2, queryTimeoutMs: 60_000 });

  try {
    const { facts, report, source, error } = await runSelfAudit({
      db,
      now: new Date(),
      windowDays: days,
      ...(merchantId ? { merchantId } : {}),
      skipAnalysis,
    });

    console.log(`\n  Self-audit — last ${days} day(s)${merchantId ? ` · merchant ${merchantId}` : ''}`);
    console.log('  ' + '─'.repeat(70));
    console.log(`  ${facts.totalCasesInWindow} case(s) created · ${facts.totalLostCases} lost (${inr(facts.lostAmount)})`);
    console.log(
      `  Lost having sent NOTHING: ${facts.lostWithNoMessage} (${inr(facts.lostWithNoMessageAmount)})`,
    );

    if (facts.buckets.length === 0) {
      console.log('\n  No rung failed to fire in this window.\n');
      return;
    }

    console.log(`\n  Buckets (${facts.buckets.length}), by money at risk:`);
    for (const b of facts.buckets) {
      const name = `${b.kind}${b.reason ? ` · ${b.reason}` : ''}`;
      console.log(
        `    ${name.padEnd(44)} ${String(b.caseCount).padStart(5)} cases · ` +
          `${inr(b.amountAtRisk).padStart(12)} · ${b.casesWithNoMessage} silent · ` +
          `${b.distinctMerchants} merchant(s)`,
      );
    }

    console.log(`\n  Analysis (${source}${error ? `: ${error}` : ''})`);
    console.log('  ' + '─'.repeat(70));
    console.log(`  ${report.summary}\n`);

    if (report.findings.length === 0) {
      console.log('  No findings.\n');
    }

    for (const f of report.findings) {
      const mark = SEVERITY_MARK[f.severity] ?? '  ';
      console.log(`  ${mark} [${f.kind}] ${f.title}  (${f.affectedCases} cases)`);
      console.log(`       evidence:  ${f.evidence}`);
      console.log(`       cause:     ${f.likelyCause}`);
      console.log(`       next:      ${f.suggestedInvestigation}\n`);
    }

    if (report.nothingElseNotable) {
      console.log('  Everything else in this window is ordinary.\n');
    }
  } finally {
    await raw.end({ timeout: 5 });
  }
}

main().catch(die);
