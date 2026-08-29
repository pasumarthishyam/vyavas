/**
 * Replay real cases against the current policy table.
 *
 *   npm run replay                 last 30 days
 *   npm run replay -- --days=7
 *   npm run replay -- --case=<id>  one case, rung by rung
 *
 * The policy-tuning loop. Edit a ladder, run this, and see what changes across
 * every real case you have — before any of it reaches a customer.
 *
 * READ-ONLY BY CONSTRUCTION. It never calls `executeRung` and never writes a
 * row. That is not caution, it is what makes the tool usable: a tuning pass you
 * have to undo afterwards is one you will not run twice, and one that logged
 * fake messages would corrupt the very report you are trying to read.
 *
 * It re-resolves the policy from the CURRENT table rather than the version
 * stamped on the case — that is the whole point. The difference between the two
 * is exactly what an edit changed.
 */

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv();

import { and, eq, gte, sql } from 'drizzle-orm';

import { createClient } from '../src/db/client.js';
import { recoveryCases } from '../src/db/schema/cases.js';
import { customers } from '../src/db/schema/customers.js';
import { merchants } from '../src/db/schema/tenancy.js';
import { POLICY_TABLE } from '../src/core/policy/index.js';
import { resolvePolicy, type PolicyMatchInput } from '../src/core/policy/resolve.js';
import { evaluatePreconditions } from '../src/core/guards/preconditions.js';
import { parseDuration } from '../src/core/policy/duration.js';
import { amountBand, formatINR, type Paise } from '../src/core/money.js';
import type { Channel } from '../src/core/actions/types.js';

const inr = (p: number) => formatINR(p as Paise, { compact: true });
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

async function main(): Promise<void> {
  const days = Number(arg('days') ?? 30);
  const oneCase = arg('case');
  const { db, sql: raw } = createClient({ max: 2 });

  try {
    const [merchant] = await db.select().from(merchants).limit(1);
    if (!merchant) {
      console.log('No merchant. Run: npm run seed:demo');
      return;
    }

    const where = oneCase
      ? eq(recoveryCases.id, oneCase)
      : and(
          eq(recoveryCases.merchantId, merchant.id),
          gte(recoveryCases.createdAt, sql`now() - make_interval(days => ${days})`),
        );

    const cases = await db
      .select({ c: recoveryCases, cust: customers })
      .from(recoveryCases)
      .leftJoin(customers, eq(customers.id, recoveryCases.customerId))
      .where(where)
      .limit(oneCase ? 1 : 2000);

    if (cases.length === 0) {
      console.log('No cases matched.');
      return;
    }

    console.log(`\n  Replaying ${cases.length} case(s) against the current policy table`);
    console.log('  ' + '─'.repeat(70));

    const changed: string[] = [];
    const byPolicy = new Map<string, { cases: number; touches: number; amount: number }>();
    let totalTouches = 0;
    let unreachable = 0;

    for (const { c, cust } of cases) {
      const input: PolicyMatchInput = {
        errorReason: c.errorReason ?? 'unknown_reason',
        errorSource: c.errorSource,
        errorStep: c.errorStep,
        method: c.method,
        bank: c.bank,
        causeClass: (c.causeClass ?? 'transient_infra') as never,
        caseType: c.type,
        amountBand: amountBand(Number(c.amountAtRiskPaise) as Paise),
        attended: c.attended,
      };

      const resolved = resolvePolicy(POLICY_TABLE, input);

      // The interesting output: a case whose ladder an edit has moved.
      if (c.policyId && c.policyId !== resolved.row.id) {
        changed.push(`${c.errorReason} · ${c.policyId} → ${resolved.row.id}`);
      }

      // Mirrors gatherFacts: a utility-category recovery message rides the
      // transactional relationship, not a marketing opt-in.
      const eligible: Channel[] = [];
      const basis = cust?.transactionalBasisAt != null;
      if (cust?.phone && (basis || cust.whatsappOptIn)) eligible.push('whatsapp');
      if (cust?.phone && (basis || cust.smsOptIn)) eligible.push('sms');
      if (cust?.email && (basis || cust.emailOptIn)) eligible.push('email');

      // Evaluated at the moment each rung would fire, not at "now" — quiet
      // hours are the whole reason the offsets matter.
      let touches = 0;
      for (const rung of resolved.row.ladder) {
        if (rung.action !== 'nudge') continue;

        const fireAt = new Date(c.createdAt.getTime() + parseDuration(rung.at));
        const gate = evaluatePreconditions(resolved.row.preconditions, {
          now: fireAt,
          orderPaid: false,
          deadlinePassed: c.deadlineAt != null && fireAt >= c.deadlineAt,
          // The replay walks one case in isolation, so there is no prior touch
          // to be inside a cool-off of, and every rung after the first is a
          // follow-up by construction.
          minutesSinceLastTouch: null,
          minGapMinutes: 0,
          isFirstTouch: touches === 0,
          minutesSinceFailure: Math.floor((fireAt.getTime() - c.createdAt.getTime()) / 60_000),
          liveCustomerWindowMinutes: 15,
          customerOptedOut: cust?.optedOutAt != null,
          eligibleChannels: eligible,
          lastAttemptAt: null,
          liveAttemptWindowMinutes: merchant.liveAttemptLockMinutes,
          recentMessageCount: touches,
          frequencyCap: merchant.frequencyCapPerDay,
          timeZone: merchant.timezone,
          quietHours: { start: merchant.quietHoursStart, end: merchant.quietHoursEnd },
          merchantBudgetRemaining: merchant.dailyMessageBudget,
          mandateActive: c.attended ? null : c.mandateId != null,
          // Replay asks what the LADDER would do, so the kill switch is held
          // open — otherwise every merchant who has not gone live yet replays
          // as a blank page.
          executionEnabled: true,
        });

        if (gate.disposition === 'proceed') touches++;

        if (oneCase) {
          console.log(
            `    ${rung.at.padStart(5)}  ${gate.disposition.padEnd(8)} ${rung.action}` +
              `${gate.disposition === 'proceed' ? '' : ` — ${gate.reason}`}`,
          );
        }
      }

      if (eligible.length === 0) unreachable++;
      totalTouches += touches;

      const agg = byPolicy.get(resolved.row.id) ?? { cases: 0, touches: 0, amount: 0 };
      agg.cases++;
      agg.touches += touches;
      agg.amount += Number(c.amountAtRiskPaise);
      byPolicy.set(resolved.row.id, agg);
    }

    if (oneCase) {
      console.log('');
      return;
    }

    console.log('\n  Ladder                                cases  touches      at risk');
    for (const [id, agg] of [...byPolicy.entries()].sort((a, b) => b[1].amount - a[1].amount)) {
      console.log(
        `    ${id.padEnd(36)} ${String(agg.cases).padStart(5)} ${String(agg.touches).padStart(8)}  ${inr(agg.amount).padStart(12)}`,
      );
    }

    console.log(`\n  Total customer touches: ${totalTouches}`);
    console.log(`  Touches per case:       ${(totalTouches / cases.length).toFixed(2)}`);
    if (unreachable > 0) {
      console.log(`  Unreachable customers:  ${unreachable} (no consented channel)`);
    }

    if (changed.length > 0) {
      console.log(`\n  ${changed.length} case(s) would now resolve to a DIFFERENT ladder:`);
      for (const line of [...new Set(changed)].slice(0, 15)) console.log(`    ${line}`);
    } else {
      console.log('\n  Every case still resolves to the ladder it was stamped with.');
    }

    console.log('\n  Nothing was written. This is a read-only projection.\n');
  } finally {
    await raw.end({ timeout: 5 });
  }
}

void main();
