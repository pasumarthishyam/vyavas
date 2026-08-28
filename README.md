# Vyavas

An AI revenue-recovery agent for merchants and platforms on **Razorpay**.

It detects revenue at risk, diagnoses the root cause, and executes a bounded
recovery workflow — across payment failures, checkout drop-off, failed
subscriptions and overdue receivables.

---

## The one idea

Those four problems look like four products. They are one object:

> **a known customer, with known intent, owes a known amount, and something broke.**

That object is a `RecoveryCase`. Build the engine once; add sources.

---

## Architecture

```
src/
├── core/        ◄── THE BRAIN.  Pure. No I/O, no clock, no randomness.
├── db/              Drizzle + Supabase (Postgres, ap-south-1)      [Stage 3]
├── adapters/        Razorpay, WhatsApp, SMS, email, Claude         [Stage 4]
├── workflows/       Inngest orchestration — no business logic      [Stage 6]
├── app/             Next.js dashboard + webhook routes             [Stage 5]
└── lib/             Result type, env, logging
```

### The boundary rule

`src/core` may not import from `db`, `adapters`, `workflows` or `app`. It may
not call `new Date()`, `Date.now()` or `Math.random()`. Every function takes
what it needs as an argument and returns a decision.

This is enforced by ESLint (`eslint.config.mjs`), not by convention. Two
consequences, and they are the point:

1. **The brain is testable with zero infrastructure.** "9:04pm IST on a Sunday
   during an ICICI netbanking outage, third attempt, mandate present" is a
   table row, not a staging environment.
2. **Nothing built later can break what is built now.** Nothing downstream can
   import into core, so Stage 1 stays finished as Stages 3–8 land.

---

## Status

| Stage | Module | State |
|-------|--------|-------|
| 0 | Spine — money, case types, state machine, action allowlist | ✅ done |
| 1 | Taxonomy & Diagnose — all 43 Razorpay codes | ✅ done |
| 2 | Policy engine — versioned ladder table + resolver | ✅ done |
| 3 | Persistence — Drizzle schema, advisory locks, webhook dedupe | ✅ done |
| 4 | Razorpay adapter + Ingest | ✅ done |
| 5 | Read-only Revenue-at-Risk dashboard → **ship to partners** | ✅ done |
| 6 | Execute (Inngest), dry-run only | ✅ done |
| 7 | Channels — WhatsApp + email, live | ✅ done |
| 8 | Measure + Partner OAuth | next |

---

## Commands

```bash
npm run verify        # policy:check + typecheck + lint + test — the gate for every stage
npm run typecheck
npm run lint
npm test
npm run test:watch
npm run test:coverage

npm run policy:build  # regenerate generated.ts after editing any policy YAML
npm run policy:check  # fail if the committed artefact is stale

npm run db:generate   # new migration from the Drizzle schema
npm run db:migrate    # apply migrations (uses DIRECT_DATABASE_URL, port 5432)
npm run db:studio     # browse the database
npm run test:integration  # concurrency proofs — needs TEST_DATABASE_URL

npm run dev           # the dashboard, http://localhost:3000
npm run build         # production build
npm run seed:demo -- --reset   # realistic demo data through the real pipeline
npm run fixtures:capture       # pull real failure payloads from Razorpay test mode

npm run dev:inngest            # local Inngest dev server (run alongside npm run dev)
npm run replay                 # what the CURRENT policy table would do to real cases
npm run replay -- --case=<id>  # one case, rung by rung, with the gate reasoning
npm run dry-run:report         # what would have been sent, and what the gate stopped

npm run templates:status       # Meta review status for the 9 templates
npm run templates:submit       # create any that are missing
npm run send:test -- --to=91XXXXXXXXXX   # one real message, end to end
```

### Database setup

Supabase project `jxiimmdduhhhtxnbemih`, region `ap-south-1` (Mumbai).
Live on Postgres 17.6: 11 tables, 16 enums, 43 indexes (11 partial).

Copy `.env.example` to `.env.local`, fill in the connection strings from the
Supabase dashboard, then:

```bash
npm run db:migrate    # apply the schema
npm run db:doctor     # assert the guarantees are actually present
```

`db:doctor` exists because "migrations applied successfully" is not the same as
the constraints being there. A partial index silently omitted still lets every
INSERT through, and the first symptom would be a customer receiving two recovery
ladders for one order. It checks each guarantee by name and prints what breaks in
the real world if one is missing.

**Credentials live in `.env.local`, which is gitignored.** `.env.example` is the
committed template and must never contain a real password.

Two things that are not optional:

- **The app uses the POOLED string (port 6543); migrations use the DIRECT one
  (5432).** Supavisor's transaction mode cannot hold the session state DDL and
  advisory locks need.
- **`prepare: false`** in `db/client.ts`. Supavisor multiplexes clients onto few
  backends, so a prepared statement created on one invocation may not exist on
  the backend the next one lands on. Leaving it on produces intermittent
  failures that only appear under concurrency — during a merchant's outage,
  when it matters most.
- **Session mode caps concurrent clients at 15** on the default plan, and
  exceeding it is a FATAL `EMAXCONNSESSION` rather than a queue. That is the
  hard argument for transaction mode with `max: 1` per invocation in production:
  session mode simply does not have the client slots for a serverless fan-out.

`npm run verify` must be green before a stage is considered done.

---

## What is built (Stages 0–1)

**Money** (`core/money.ts`) — integer paise with a branded type, so
`amount + 0.5` is a compile error. Indian lakh/crore formatting. `shareOf()` in
basis points for commission on recovered revenue.

**Case model** (`core/case/`) — the four case types, the seven states, a
transition table where terminal is genuinely terminal, and intent-decay
deadlines.

**Action allowlist** (`core/actions/types.ts`) — the complete vocabulary of
things the agent may do. The planner emits a value of this union and nothing
else; it never gets a generic handle on the Razorpay API. Bounded autonomy as a
type, not as a prompt.

**Taxonomy** (`core/taxonomy/`) — all 43 documented Razorpay failure reasons
across the general, card and gateway lists, mapped to nine cause classes, with
the disambiguation rules that make `(code, source, step, reason, method)` the
routing key rather than `reason` alone.

**Diagnose** (`core/taxonomy/diagnose.ts`) — tuple + context → what is wrong and
how we may behave. Applies the live downtime override, tightens on attempt
history before an instrument gets locked, and decides attended vs unattended.

**Cohort** (`core/cohort.ts`) — deterministic holdout assignment, stable under
rate changes so historical incrementality numbers stay valid.

**Policy engine** (`core/policy/`) — 27 versioned ladder rows authored as YAML,
one file per cause class, compiled to a frozen table with a weighted
most-specific-wins resolver. `compile.ts` is where the real work is: it refuses
any table that could instruct the agent to do something indefensible — a ladder
exceeding its cause class's touch ceiling, a nudge landing before the class
floor, `retry_same` on an instrument that can never work, a debit on an
attended case or without RBI pre-debit notice, a customer-facing row that does
not abort on `order_paid`, or two rows whose winner depends on declaration order.

The governing rule: **a policy may tighten a safety limit, never loosen one.**
Cause-class traits are the ceiling; policy rows live under them.

`effectiveRails()` is the runtime counterpart — where the static table and the
live diagnosis disagree, the diagnosis wins and may only ever remove rails. A
policy can never re-authorise something the diagnosis has ruled out.

**Persistence** (`src/db/`) — 11 tables, one migration, driver-agnostic repos.
The guarantees that matter are enforced by Postgres, not by application care:

| Guarantee | Mechanism |
|---|---|
| One live case per order | partial unique index on live states |
| A replayed rung never fires twice | unique `idempotency_key` on actions and messages |
| A retried webhook is a no-op | `ON CONFLICT DO NOTHING … RETURNING` on the event id |
| A customer is never messaged twice at once | `pg_advisory_xact_lock` keyed on the person |
| The cap is global per person, not per case | `message_log` keyed on `customer_id` |
| Holdouts don't eat the treatment budget | partial index excluding suppressed rows |
| One open alert per condition | partial unique index on unresolved alerts |
| A new merchant sends nothing | `dry_run: true`, `execution_enabled: false` by default |

**Razorpay adapter** (`src/adapters/razorpay/`) — HMAC-SHA256 webhook
verification over the raw bytes, an HTTP client that distinguishes retryable
(429/5xx/timeout) from permanent (4xx) failures, and the resource calls. The
one that matters most is `isOrderPaid`, the precondition re-checked before every
customer touch — it asks Razorpay rather than trusting local state, and treats
an API failure as "paid", because a message we failed to send costs one order
while a message to someone who already paid costs the relationship.

**Ingest** (`src/ingest/`) — `normalize → diagnose → resolve → persist`, as a
plain function over a `Database`. Deliberately not a Next.js route: the whole
contract is testable without a server, and the HTTP layer is five lines of
wrapper. The webhook entry point verifies, claims the delivery, hands off, and
returns 200 — always 200 once a delivery is accepted, because a 500 makes
Razorpay resend an event we already claimed, the dedupe swallows the resend, and
the event is lost. The redrive sweep recovers failures, not Razorpay's retry.

**Dashboard** (`src/app/`) — Next.js on Vercel. Read-only: it never writes to a
case and never sends anything. Three views — the Revenue-at-Risk overview, a
filterable case list, and a case detail that shows the raw tuple, the diagnosis
rationale in plain language, and **the ladder that would run**. That last part is
what makes this shippable on its own: a merchant sees exactly what the agent
would say, to whom, and when, before granting write access to anything.

Design decisions worth knowing:

- **No chart library and no CSS framework.** Inline SVG and hand-written CSS with
  design tokens. Full control over the marks, nothing to load.
- **Cause classes and banks get ONE hue.** Darkening a bar by its own value would
  double-encode length as colour and burn the only free channel on information
  the bar already shows. The heatmap is the one legitimate exception — a grid of
  continuous magnitude is exactly what a sequential ramp is for.
- **Status colour never carries meaning alone.** Two of the four status steps sit
  below 3:1 on the light surface by design, so every one is paired with an icon
  and a word.
- **Money is masked at the query layer, not the template.** A support screenshot
  should never carry a full phone number, and relying on each view to remember
  that is how one eventually does not.

```bash
npm run seed:demo -- --reset   # 320 cases through the REAL pipeline
npm run dev                    # http://localhost:3000
```

The seed calls `processEvent` — the same function the webhook route calls — so
the dashboard shows data the system genuinely produced, and seeding doubles as
an end-to-end smoke test against the live database.

The database tests run against **PGlite** — real Postgres compiled to WASM,
in-process — so `npm test` exercises partial unique indexes, `ON CONFLICT`,
native enums and advisory locks with no external database to start. PGlite is
single-connection, so the contention proofs live in
`tests/db/concurrency.integration.test.ts` and run against a real Postgres when
`TEST_DATABASE_URL` is set.

### The tests that matter

- `tests/golden/fixtures.ts` — one fixture per error code, plus scenarios for
  downtime, attempt history and mandates.
- `tests/golden/exhaustiveness.test.ts` — **fails CI if any code lacks a
  fixture**, if two rules tie ambiguously, or if any reachable tuple produces an
  inconsistent diagnosis. It brute-forces the entire
  reason × source × step × method space.

That second file is what makes Stage 1 *finished* rather than merely written. It
is the thing standing between this taxonomy and the fate of every dunning tool
on the market: a dozen codes handled properly and a generic email for everything
else.

---

## Non-negotiables

- **Money is integer paise.** Never a float. Anywhere.
- **`attended` is decided explicitly on every case.** Under RBI rules there is
  no lawful silent card retry in India without a mandate. Getting this wrong is
  a compliance incident, not a bug.
- **`order_already_paid` closes the case and cancels everything queued.**
  Messaging a customer who has already paid is the one mistake that ends the
  relationship.
- **A deliberate exit is never dressed as a failure.** `payment_cancelled` is a
  live intent signal; it gets its own case type and never sees failure language.
- **Risk declines get one touch on one alternate rail.** Re-presenting raises
  the risk score and degrades the merchant's authorisation rate.
- **Merchant-fault classes alert the merchant with facts, not prescriptions.**
  Turning off a payment method is their commercial decision, not ours.
