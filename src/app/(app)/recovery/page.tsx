import { getDb } from '../../../db/client';
import {
  getAiHealth,
  getConsoleMerchant,
  getEscalatedCaseIds,
  getOpenAlerts,
  getOpenEscalations,
  getRecentActivity,
  getRecoverableCases,
  getRecoverySummary,
  type ActivityRow,
  type AiHealth,
  type ConsoleAlert,
  type ConsoleEscalation,
  type ConsoleMerchant,
  type RecoverableCase,
  type RecoverySummary,
} from '../../../db/queries/recovery';
import { selectMerchant } from '../../../lib/merchant-context';
import { RecoveryConsole } from '../../../components/recovery-console';
import { Empty } from '../../../components/charts';

/**
 * The recovery console.
 *
 * Server-rendered once with real data so the page is useful before any
 * JavaScript runs, then the client component takes over and polls.
 *
 * ── why every read here is inside a try ──
 *
 * It was not, and the result was the worst failure mode this page has: one
 * pooled connection going stale between requests threw, the throw escaped the
 * server component, and Next replaced the entire UI with "Application error: a
 * server-side exception has occurred" and a digest number. A transient blip
 * became a blank screen with no console, no data and no way back except a
 * manual reload.
 *
 * The shell does not actually need the server pass to work — the client polls
 * `/api/recovery/status` every few seconds and will fill itself in. So a failed
 * read is downgraded to an empty first paint plus a banner, and the poll
 * recovers it on its own. The server render is an optimisation, and an
 * optimisation must never be able to take the page down.
 */
export const dynamic = 'force-dynamic';

interface Loaded {
  merchant: ConsoleMerchant | null;
  cases: RecoverableCase[];
  activity: ActivityRow[];
  summary: RecoverySummary;
  escalations: ConsoleEscalation[];
  alerts: ConsoleAlert[];
  ai: AiHealth;
  escalatedCaseIds: string[];
  failed: boolean;
}

const EMPTY_SUMMARY: RecoverySummary = {
  recoveredPaise: 0,
  recoveredCases: 0,
  failureClasses: 0,
};

const EMPTY_AI: AiHealth = {
  configured: false,
  briefsByClaude: 0,
  briefsByFallback: 0,
  lastError: null,
  lastWrittenAt: null,
};

const EMPTY: Omit<Loaded, 'merchant' | 'failed'> = {
  cases: [],
  activity: [],
  summary: EMPTY_SUMMARY,
  escalations: [],
  alerts: [],
  ai: EMPTY_AI,
  escalatedCaseIds: [],
};

async function load(): Promise<Loaded> {
  try {
    const db = getDb();
    const selection = await selectMerchant(db);
    const merchant = selection ? await getConsoleMerchant(db, selection.current.id) : null;

    if (!merchant) {
      return { merchant: null, ...EMPTY, failed: false };
    }

    const [cases, activity, summary, escalations, alerts, ai, escalatedCaseIds] =
      await Promise.all([
        getRecoverableCases(db, merchant.id),
        getRecentActivity(db, merchant.id, 40),
        getRecoverySummary(db, merchant.id),
        getOpenEscalations(db, merchant.id),
        getOpenAlerts(db, merchant.id),
        getAiHealth(db, merchant.id),
        getEscalatedCaseIds(db, merchant.id),
      ]);

    return { merchant, cases, activity, summary, escalations, alerts, ai, escalatedCaseIds, failed: false };
  } catch {
    // Deliberately swallowed. The client poll is the recovery path, and it
    // reports its own failures — surfacing this one too would show two banners
    // for one fault.
    return { merchant: null, ...EMPTY, failed: true };
  }
}

export default async function RecoveryPage() {
  const { merchant, cases, activity, summary, escalations, alerts, ai, escalatedCaseIds, failed } =
    await load();

  // Only a genuinely empty install gets the empty state. A failed read renders
  // the console instead, so the poll can quietly repair it.
  if (!merchant && !failed) {
    return (
      <>
        <div className="page-head">
          <div>
            <div className="eyebrow">Recovery</div>
            <h1>Recovery</h1>
          </div>
        </div>
        <Empty
          title="No merchant connected"
          body="Connect a Razorpay account and run npm run backfill to pull in real failures."
        />
      </>
    );
  }

  return (
    <RecoveryConsole
      initial={{
        merchant,
        /*
         * Routing ships with the FIRST paint, not with the first poll.
         *
         * This was the page's worst layout shift and the reason it appeared to
         * "adjust itself" a couple of seconds after opening: the server render
         * omitted `routing`, so `<Routing>` rendered nothing; the poll at
         * POLL_MS came back with it, a full-width banner appeared out of
         * nowhere, and every panel below — the queue, the case table, activity
         * — jumped down by its height. The merchant row already carries these
         * three columns, so there was never a reason to wait for the network.
         */
        routing: merchant
          ? {
              whatsappRedirectTo: merchant.whatsappRedirectTo,
              emailRedirectTo: merchant.emailRedirectTo,
              emailFrom: merchant.emailFrom,
            }
          : undefined,
        cases,
        activity,
        summary,
        escalations,
        alerts,
        ai,
        escalatedCaseIds,
        now: new Date().toISOString(),
        degraded: failed,
      }}
    />
  );
}
