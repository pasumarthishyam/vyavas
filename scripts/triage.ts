/**
 * Unknown-reason triage.
 *
 *   npm run triage                 propose classifications for unknown reasons
 *   npm run triage -- --days=90
 *   npm run triage -- --list       show pending proposals, propose nothing
 *   npm run triage -- --dry        show what WOULD be triaged, call no model
 *
 * A Razorpay reason with no descriptor lands on `unknown_reason` with low
 * confidence and gets a cautious ladder. That is correct and it is silent: a
 * new code costing money since Monday looks exactly like a quiet week.
 *
 * NOTHING HERE IS APPLIED. Each run writes a proposal for a person to review;
 * accepting one means hand-writing the rule into `codes.ts` with a golden
 * fixture, like every other entry in the taxonomy. The taxonomy is the safety
 * ceiling for the whole agent — a wrong cause class does not produce a badly
 * worded message, it produces a locked card.
 */

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv();

import { createClient } from '../src/db/client.js';
import { listPendingProposals } from '../src/db/repos/proposals.js';
import { findUnknownReasons, runTriage } from '../src/ops/triage.js';
import { die, flag } from './lib.js';

async function main(): Promise<void> {
  const days = Number(flag('days') ?? 30);
  const listOnly = process.argv.includes('--list');
  const dry = process.argv.includes('--dry');

  const { db, sql: raw } = createClient({ max: 2, queryTimeoutMs: 60_000 });

  try {
    if (listOnly) {
      const pending = await listPendingProposals(db);
      console.log(`\n  Pending taxonomy proposals: ${pending.length}`);
      console.log('  ' + '─'.repeat(70));

      for (const p of pending) {
        console.log(`\n  "${p.rawErrorReason}"  (${p.occurrences} occurrences)`);
        console.log(`    proposed:  ${p.proposedCauseClass}  [${p.confidence} confidence]`);
        console.log(`    rule id:   ${p.proposedRuleId}`);
        console.log(`    retry same instrument: ${p.sameInstrumentRetrySafe}`);
        console.log(`    reasoning: ${p.reasoning}`);
        if (p.disambiguationNote) console.log(`    keys on:   ${p.disambiguationNote}`);
        if (p.reviewerShouldVerify) console.log(`    VERIFY:    ${p.reviewerShouldVerify}`);
      }
      console.log('');
      return;
    }

    if (dry) {
      const groups = await findUnknownReasons(db, { sinceDays: days });
      console.log(`\n  Unknown reasons worth triaging in the last ${days} days: ${groups.length}`);
      console.log('  ' + '─'.repeat(70));
      for (const g of groups) {
        console.log(
          `    ${g.rawErrorReason.padEnd(40)} ${String(g.occurrences).padStart(5)}x · ` +
            `${g.distinctMerchants} merchant(s) · ${g.eventuallyPaidCount} eventually paid`,
        );
      }
      console.log('\n  Nothing was proposed. Re-run without --dry to ask for classifications.\n');
      return;
    }

    const outcomes = await runTriage(db, { sinceDays: days });

    console.log(`\n  Triage — last ${days} day(s)`);
    console.log('  ' + '─'.repeat(70));

    if (outcomes.length === 0) {
      console.log('  No unknown reasons above the occurrence floor. Nothing to propose.\n');
      return;
    }

    for (const o of outcomes) {
      if (o.status === 'failed') {
        console.error(`  ✗ ${o.rawErrorReason} (${o.occurrences}x) — ${o.error}`);
        continue;
      }
      console.log(
        `  ✓ ${o.rawErrorReason.padEnd(40)} → ${o.proposedCauseClass} [${o.confidence}]`,
      );
    }

    const proposed = outcomes.filter((o) => o.status === 'proposed').length;
    console.log(
      `\n  ${proposed} proposal(s) written, all PENDING. None has been applied.\n` +
        `  Review them with: npm run triage -- --list\n`,
    );
  } finally {
    await raw.end({ timeout: 5 });
  }
}

main().catch(die);
