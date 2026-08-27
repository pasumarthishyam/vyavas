/**
 * The dry-run report.
 *
 *   npm run dry-run:report
 *
 * This is the deliverable of Stage 6, and the thing you put in front of a
 * design partner: two weeks of THEIR real traffic, showing exactly what would
 * have been said, to whom, and when — before they are asked to let anything
 * send.
 *
 * It reads only what the executor actually recorded. Nothing here re-derives a
 * decision, because a report that recomputes what the system "would" do is a
 * report about the report, not about the system.
 */

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv();

import { sql } from 'drizzle-orm';

import { createClient } from '../src/db/client.js';
import { formatINR, type Paise } from '../src/core/money.js';

const inr = (p: number) => formatINR(p as Paise, { compact: true });

interface Row {
  [k: string]: unknown;
}

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const r = (result as { rows: unknown }).rows;
    if (Array.isArray(r)) return r as Row[];
  }
  return [];
}

async function main(): Promise<void> {
  const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 14);
  const { db, sql: raw } = createClient({ max: 2 });

  try {
    const [merchant] = rows(
      await db.execute(sql`select id, name, dry_run, execution_enabled from merchants limit 1`),
    );
    if (!merchant) {
      console.log('No merchant. Run: npm run seed:demo');
      return;
    }

    const mid = merchant.id as string;

    console.log(`\n  ${merchant.name} — dry-run report, last ${days} days`);
    console.log(`  execution ${merchant.execution_enabled ? 'ENABLED' : 'disabled'} · dry_run ${merchant.dry_run ? 'ON' : 'off'}`);
    console.log('  ' + '─'.repeat(66));

    // ── what would have been sent ──
    const planned = rows(
      await db.execute(sql`
        select suppressed_reason, channel, intent, count(*)::int as n
        from message_log
        where merchant_id = ${mid}
          and sent_at > now() - make_interval(days => ${days})
        group by suppressed_reason, channel, intent
        order by n desc
      `),
    );

    const total = planned.reduce((s, r) => s + Number(r.n), 0);
    const actuallySent = planned
      .filter((r) => r.suppressed_reason === null)
      .reduce((s, r) => s + Number(r.n), 0);

    console.log(`\n  MESSAGES PLANNED: ${total}`);
    console.log(`  ACTUALLY SENT:    ${actuallySent}${actuallySent === 0 ? '   ← nothing left the building' : ''}`);

    if (planned.length > 0) {
      console.log('\n  By intent and channel:');
      for (const r of planned) {
        const why = r.suppressed_reason ? String(r.suppressed_reason) : 'SENT';
        console.log(
          `    ${String(r.n).padStart(4)}  ${String(r.intent).padEnd(28)} ${String(r.channel).padEnd(9)} ${why}`,
        );
      }
    }

    // ── why rungs did not fire ──
    const gated = rows(
      await db.execute(sql`
        select kind, reason, count(*)::int as n
        from case_events
        where merchant_id = ${mid}
          and kind in ('rung_aborted', 'rung_deferred')
          and occurred_at > now() - make_interval(days => ${days})
        group by kind, reason
        order by n desc
      `),
    );

    if (gated.length > 0) {
      console.log('\n  Rungs the gate stopped:');
      for (const r of gated) {
        const verb = r.kind === 'rung_aborted' ? 'aborted' : 'deferred';
        console.log(`    ${String(r.n).padStart(4)}  ${verb.padEnd(9)} ${String(r.reason)}`);
      }
    }

    // ── the holdout comparison ──
    //
    // The only honest measure of what recovery is worth. Both cohorts ran the
    // same ladder through the same gate; one had messages suppressed as a
    // control.
    const cohorts = rows(
      await db.execute(sql`
        select cohort,
               count(*)::int as cases,
               count(*) filter (where state = 'recovered')::int as recovered,
               coalesce(sum(amount_at_risk_paise), 0)::bigint as at_risk,
               coalesce(sum(case when state = 'recovered'
                 then coalesce(recovered_amount_paise, amount_at_risk_paise) else 0 end), 0)::bigint as won
        from recovery_cases
        where merchant_id = ${mid}
          and created_at > now() - make_interval(days => ${days})
        group by cohort
      `),
    );

    if (cohorts.length > 0) {
      console.log('\n  Cohorts:');
      for (const c of cohorts) {
        const rate = Number(c.cases) > 0 ? (Number(c.recovered) / Number(c.cases)) * 100 : 0;
        console.log(
          `    ${String(c.cohort).padEnd(10)} ${String(c.cases).padStart(4)} cases · ` +
            `${String(c.recovered).padStart(3)} recovered (${rate.toFixed(1)}%) · ${inr(Number(c.won))}`,
        );
      }
      console.log(
        '\n  Incrementality is not reported yet: while nothing sends, the two\n' +
          '  cohorts received identical treatment, so any difference between them\n' +
          '  is noise. The comparison becomes meaningful in Stage 7.',
      );
    }

    console.log('');
  } finally {
    await raw.end({ timeout: 5 });
  }
}

void main();
